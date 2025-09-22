import express from "express";
import fetch from "node-fetch";
import { JSDOM } from "jsdom";
import http from "http";
import WebSocket from "ws";
import bodyParser from "body-parser";
import { PassThrough } from "stream";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// ---- フォームページ ----
app.get("/", (req, res) => {
  res.send(`
    <html>
    <head>
      <title>完全プロキシ 強化版</title>
      <style>
        body{font-family:Arial,sans-serif;background:#f5f5f5;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}
        .container{background:#fff;padding:30px;border-radius:10px;box-shadow:0 4px 12px rgba(0,0,0,0.15);text-align:center;}
        input{width:300px;padding:8px;margin-right:10px;}
        button{padding:8px 12px;}
      </style>
    </head>
    <body>
      <div class="container">
        <h2>完全プロキシサイト（強化版）</h2>
        <form method="get" action="/proxy">
          <input type="text" name="url" placeholder="Enter URL"/>
          <button>Go</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

// ---- ストリーミング対応 ----
async function streamProxy(targetUrl, req, res){
  const headers = {};
  if(req.headers.range) headers['range'] = req.headers.range;
  if(req.headers['accept-encoding']) headers['accept-encoding'] = req.headers['accept-encoding'];

  const response = await fetch(targetUrl, { headers });
  res.status(response.status);
  response.headers.forEach((v,k)=> res.setHeader(k,v));

  const reader = response.body.getReader();
  const pass = new PassThrough();
  res.on("close", ()=> reader.cancel());

  async function pump(){
    const {done, value} = await reader.read();
    if(done){ pass.end(); return; }
    pass.write(value);
    pump();
  }
  pump();
  pass.pipe(res);
}

// ---- プロキシ処理 ----
async function proxyRequest(targetUrl, req, res, method="GET", body=null){
  if(!targetUrl) return res.send("URLを入力してください");

  try {
    const headers = {};
    if(req.headers.range) headers['range'] = req.headers.range;
    if(req.headers['accept-encoding']) headers['accept-encoding'] = req.headers['accept-encoding'];

    const fetchOptions = { method, headers };
    if(body){
      if(method==="POST") fetchOptions.body = new URLSearchParams(body);
      else fetchOptions.body = body;
    }

    const response = await fetch(targetUrl, fetchOptions);
    const contentType = response.headers.get("content-type") || "";

    if(response.headers.has("set-cookie")) res.setHeader("set-cookie", response.headers.get("set-cookie"));
    if(response.status===206) res.status(206);

    // ---- HTMLの場合 ----
    if(contentType.includes("text/html")){
      let html = await response.text();
      const dom = new JSDOM(html);
      const document = dom.window.document;

      // <base> タグで相対パス解決
      const base = document.createElement("base");
      base.href = targetUrl;
      document.head.prepend(base);

      const baseUrl = new URL(targetUrl);

      // リンク・フォーム・画像・動画・スクリプトを書き換え（相対パス補完）
      [...document.querySelectorAll("a,link,form,script,img,iframe,video,audio")].forEach(el => {
        const attr = el.href ? "href" : el.src ? "src" : null;
        if(!attr) return;
        try {
          let url = new URL(el[attr], baseUrl).href;
          // 外部 CDN は書き換え除外
          if(url.includes("google.com") || url.includes("cdnjs.cloudflare.com")) return;
          el[attr] = "/proxy?url=" + encodeURIComponent(url);
        } catch(e){}
      });

      // 広告・トラッキング除去（簡易）
      document.querySelectorAll('iframe,script').forEach(el=>{
        if(el.src && (el.src.includes('ads')||el.src.includes('doubleclick'))) el.remove();
      });

      // ---- クライアント側 JS フック ----
      const script = document.createElement("script");
      script.textContent = `
        (function(){
          const encodeProxy = url=>'/proxy?url='+encodeURIComponent(url);
          // fetch
          const origFetch=window.fetch;
          window.fetch=function(input,init){if(typeof input==='string'&&input.startsWith('http'))input=encodeProxy(input);return origFetch(input,init);}
          // XHR
          const origXHR=XMLHttpRequest.prototype.open;
          XMLHttpRequest.prototype.open=function(m,url){if(url.startsWith('http'))url=encodeProxy(url);return origXHR.apply(this,arguments);}
          // eval/Function
          const origEval=window.eval;
          window.eval=code=>origEval(code.replace(/(https?:\\/\\/[^\\s'"]+)/g,encodeProxy));
          const OrigFunction=Function;
          window.Function=function(...args){const body=args.pop().replace(/(https?:\\/\\/[^\\s'"]+)/g,encodeProxy);return OrigFunction(...args,body);}
          // setTimeout/setInterval 内文字列
          const origSetTimeout=window.setTimeout;
          window.setTimeout=(fn,t,...args)=>origSetTimeout(typeof fn==='string'?()=>eval(fn):fn,t,...args);
          const origSetInterval=window.setInterval;
          window.setInterval=(fn,t,...args)=>origSetInterval(typeof fn==='string'?()=>eval(fn):fn,t,...args);
          // createElement 書き換え
          const origCreate=document.createElement.bind(document);
          document.createElement=function(tag){const el=origCreate(tag);if(['script','iframe','img'].includes(tag.toLowerCase())){const origSetAttr=el.setAttribute.bind(el);el.setAttribute=(a,v)=>{if((a==='src'||a==='href')&&v.startsWith('http'))v=encodeProxy(v);return origSetAttr(a,v);}};return el;}
          // WebSocket
          const OriginalWS=window.WebSocket;
          window.WebSocket=function(url,protocols){if(url.startsWith('ws'))url=url.replace(/^ws(s)?:/,location.protocol==='https:'?'wss:':'ws:');return new OriginalWS(url,protocols);}
        })();
      `;
      document.body.appendChild(script);

      res.send(dom.serialize());
      return;
    }

    // ---- HTML 以外はストリーミング ----
    await streamProxy(targetUrl, req, res);

  } catch(e){
    res.send("アクセスできません: "+e.message);
  }
}

// GET
app.get("/proxy", async (req,res)=> {
  const url = req.query.url;
  await proxyRequest(url, req, res, "GET");
});

// POST
app.post("/proxy", async (req,res)=> {
  const url = req.query.url;
  await proxyRequest(url, req, res, "POST", req.body);
});

// ---- WebSocket 完全中継 ----
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on("connection", clientWS => {
  console.log("WebSocket connected");
  clientWS.on("message", async msg => {
    try{
      const data = JSON.parse(msg);
      if(data.type==='connect' && data.url){
        const targetWS = new WebSocket(data.url);
        targetWS.on("open", ()=> clientWS.send(JSON.stringify({type:'status',msg:'connected'})));
        targetWS.on("message", m=> clientWS.send(JSON.stringify({type:'message',msg:m.toString()})));
        targetWS.on("close", ()=> clientWS.send(JSON.stringify({type:'status',msg:'closed'})));
        targetWS.on("error", e=> clientWS.send(JSON.stringify({type:'error',msg:e.message})));
        clientWS.on("message", msg2=>{const d=JSON.parse(msg2);if(d.type==='send') targetWS.send(d.payload);});
      }
    }catch(e){ console.error(e) }
  });
});

// ---- サーバー起動 ----
server.listen(PORT, ()=> console.log(`完全プロキシ 強化版 実行中 http://localhost:${PORT}`));
