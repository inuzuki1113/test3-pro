import express from "express";
import fetch from "node-fetch";
import { JSDOM } from "jsdom";
import http from "http";
import WebSocket from "ws";
import bodyParser from "body-parser";
import { PassThrough } from "stream";

const app = express();
const PORT = process.env.PORT || 3000;

// ---- ミドルウェア ----
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// ---- フォームページ ----
app.get("/", (req, res) => {
  res.send(`
    <html>
      <head><title>完全プロキシ 強化版</title></head>
      <body>
        <h2>完全プロキシサイト（強化版）</h2>
        <form method="get" action="/proxy">
          <input type="text" name="url" placeholder="Enter URL" style="width:400px"/>
          <button>Go</button>
        </form>
        <button onclick="window.history.back()">戻る</button>
        <button onclick="location.reload()">リロード</button>
      </body>
    </html>
  `);
});

// ---- ストリーミング対応プロキシ ----
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

// ---- GET/POST 共通プロキシ処理 ----
async function proxyRequest(targetUrl, req, res, method="GET", body=null){
  if(!targetUrl) return res.send("URLを入力してください");

  // HTML / 非HTML 判断
  try {
    const headers = {};
    if(req.headers.range) headers['range'] = req.headers.range;
    if(req.headers['accept-encoding']) headers['accept-encoding'] = req.headers['accept-encoding'];

    const fetchOptions = { method, headers };
    if(body) {
      if(method==="POST"){
        fetchOptions.body = new URLSearchParams(body);
      } else {
        fetchOptions.body = body;
      }
    }

    const response = await fetch(targetUrl, fetchOptions);
    const contentType = response.headers.get("content-type") || "";

    // Cookie中継
    if(response.headers.has("set-cookie")){
      res.setHeader("set-cookie", response.headers.get("set-cookie"));
    }

    // 206 Partial Content 対応
    if(response.status === 206) res.status(206);

    // ---- HTML の場合 ----
    if(contentType.includes("text/html")){
      let html = await response.text();
      const dom = new JSDOM(html);
      const document = dom.window.document;

      // 広告・トラッキング除去
      document.querySelectorAll('iframe, script').forEach(el=>{
        if(el.src && (el.src.includes('ads') || el.src.includes('doubleclick'))){
          el.remove();
        }
      });

      // リンク・フォーム・画像・動画・スクリプト書き換え
      [...document.querySelectorAll("a,link,form,script,img,iframe,video,audio")].forEach(el=>{
        if(el.tagName==="FORM") el.action="/proxy?url="+encodeURIComponent(el.action||targetUrl);
        else if(el.href) el.href="/proxy?url="+encodeURIComponent(el.href);
        else if(el.src) el.src="/proxy?url="+encodeURIComponent(el.src);
      });

      // ---- クライアント側 JS フック ----
      const script = document.createElement("script");
      script.textContent = `
        (function(){
          const encodeProxy = url => '/proxy?url=' + encodeURIComponent(url);

          // fetch
          const origFetch = window.fetch;
          window.fetch = function(input, init){
            if(typeof input==='string' && input.startsWith('http')) input=encodeProxy(input);
            return origFetch(input, init);
          };

          // XHR
          const origXHR = XMLHttpRequest.prototype.open;
          XMLHttpRequest.prototype.open = function(method,url){
            if(url.startsWith('http')) url=encodeProxy(url);
            return origXHR.apply(this, arguments);
          };

          // eval & Function
          const origEval = window.eval;
          window.eval = code => origEval(code.replace(/(https?:\\/\\/[^\\s'"]+)/g, encodeProxy));
          const OrigFunction = Function;
          window.Function = function(...args){
            const body = args.pop().replace(/(https?:\\/\\/[^\\s'"]+)/g, encodeProxy);
            return OrigFunction(...args, body);
          };

          // setTimeout/setInterval 内文字列
          const origSetTimeout = window.setTimeout;
          window.setTimeout = (fn,t,...args) => origSetTimeout(typeof fn==='string'?()=>eval(fn):fn,t,...args);
          const origSetInterval = window.setInterval;
          window.setInterval = (fn,t,...args) => origSetInterval(typeof fn==='string'?()=>eval(fn):fn,t,...args);

          // 動的 script/img/iframe 書き換え
          const origCreate = document.createElement.bind(document);
          document.createElement = function(tag){
            const el = origCreate(tag);
            if(['script','iframe','img'].includes(tag.toLowerCase())){
              const origSetAttr = el.setAttribute.bind(el);
              el.setAttribute = (attr,val)=>{
                if((attr==='src'||attr==='href') && val.startsWith('http')) val=encodeProxy(val);
                return origSetAttr(attr,val);
              };
            }
            return el;
          };

          // WebSocket プロキシ（簡易版）
          const OriginalWS = window.WebSocket;
          window.WebSocket = function(url,protocols){
            if(url.startsWith('ws')) url = url.replace(/^ws(s)?:/, location.protocol==='https:'?'wss:':'ws:');
            return new OriginalWS(url,protocols);
          };

        })();
      `;
      document.body.appendChild(script);

      res.send(dom.serialize());
      return;
    }

    // ---- HTML 以外はストリーミング中継 ----
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

// ---- WebSocket サーバー 完全中継 ----
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

        clientWS.on("message", msg2=>{
          const d = JSON.parse(msg2);
          if(d.type==='send') targetWS.send(d.payload);
        });
      }
    }catch(e){ console.error(e) }
  });
});

// ---- サーバー起動 ----
server.listen(PORT, ()=> console.log(`完全プロキシ 強化版 実行中 http://localhost:${PORT}`));
