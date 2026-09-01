/* Does a RETURNING visitor get the build that was deployed?
 *
 * Every other gate here launches Chrome with a fresh profile, so every one of them starts
 * with an empty cache. That is why the worst bug this project has shipped was invisible to
 * all of them: the page versioned its module entry point as `player.js?v=<hash>` while the
 * modules that entry point imports sat at bare URLs served `immutable, max-age=31536000`.
 * An ES module's `import './stage.js'` resolves against the importing module's own URL, so
 * those never carried a version. A returning visitor ran the new player against a year-old
 * renderer and their browser never asked the server whether anything had changed.
 *
 * So this loads the site twice in the SAME profile and compares. Only a warm cache can
 * catch it, and only a returning visitor would ever have seen it - the worst possible
 * audience to find a bug.
 *
 *   node tests/cache_staleness.mjs [url]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const URL_ = process.argv[2] ?? 'http://127.0.0.1:8007/';
const PORT=9950+Math.floor(Math.random()*40); const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const profileDir = mkdtempSync(join(tmpdir(),'bf-stale-'));   // ONE profile, reused
async function run(label){
  const chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ['--headless=new','--no-sandbox',`--remote-debugging-port=${PORT}`,`--user-data-dir=${profileDir}`,
     '--no-first-run','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','about:blank'],
    {stdio:['ignore','ignore','pipe']});
  async function ep(){for(let i=0;i<120;i++){try{const r=await fetch(`http://127.0.0.1:${PORT}/json/version`);if(r.ok)return (await r.json()).webSocketDebuggerUrl;}catch{}await sleep(200);}throw new Error('no port');}
  const ws=new WebSocket(await ep()); await new Promise((s,f)=>{ws.onopen=s;ws.onerror=f;});
  let id=1;const pending=new Map();
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}};
  const send=(mm,p={},s)=>{const i=id++;return new Promise((res,rej)=>{pending.set(i,{resolve:res,reject:rej});ws.send(JSON.stringify({id:i,method:mm,params:p,sessionId:s}));});};
  const {targetId}=await send('Target.createTarget',{url:'about:blank'});
  const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
  await send('Runtime.enable',{},sessionId); await send('Page.enable',{},sessionId);
  await send('Page.navigate',{url:URL_},sessionId);
  const ev=async x=>{const {result,exceptionDetails}=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true},sessionId);if(exceptionDetails)throw new Error(exceptionDetails.exception?.description);return result.value;};
  let ok=false;
  for(let i=0;i<60;i++){await sleep(500);if(await ev('!!(window.buttfoldPlayer&&window.buttfoldPlayer.frames.length)')){ok=true;break;}}
  const info = ok ? await ev(`(()=>{const p=window.buttfoldPlayer;const f=p.frames[p.frames.length-1];
    return {fold:p.fold.id, hasSsConf:!!f.ssConfidence, cartoon: typeof p.stage.buffers!=='undefined' && !!p.stage.buffers.residue,
            verts: p.stage.buffers ? p.stage.buffers.structure.length : 0};})()`) : {error:'never loaded'};
  chrome.kill(); await sleep(600);
  console.log(label.padEnd(18), JSON.stringify(info));
  return info;
}
const first = await run('cold cache');
const second = await run('WARM cache');
const fails=[];
for (const k of ['fold','hasSsConf','cartoon','verts'])
  if (JSON.stringify(first[k])!==JSON.stringify(second[k])) fails.push(`${k}: ${first[k]} then ${second[k]}`);
if (!first.cartoon || !second.cartoon) fails.push('the cartoon renderer is not the one running');
if (!first.hasSsConf || !second.hasSsConf) fails.push('the fold JSON carries no ssConf: a stale API response');
if (fails.length){console.error('\nFAIL'); fails.forEach(f=>console.error('  - '+f)); process.exit(1);}
console.log('\nPASS: a warm cache runs the same build as a cold one');
