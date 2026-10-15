import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
const root = fileURLToPath(new URL('../', import.meta.url))
const temp = mkdtempSync(path.join(os.tmpdir(), 'maestro-client-transport-package-'))
const run = (args, cwd) => execFileSync('npm', args, { cwd, encoding: 'utf8', stdio: 'pipe' })
const source = `
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import React from 'react'
import { renderToString } from 'react-dom/server'
import * as esm from 'dooers-agents-client/maestro'
import * as legacy from 'dooers-agents-client'
const require = createRequire(import.meta.url)
const cjs = require('dooers-agents-client/maestro')
const legacyCjs = require('dooers-agents-client')
assert.equal(typeof legacy.AgentServerClient, 'function')
assert.equal(typeof legacyCjs.AgentServerClient, 'function')
const org = '00000000-0000-4000-8000-000000000001'
const thread = '00000000-0000-4000-8000-000000000002'
const eventId = '00000000-0000-4000-8000-000000000003'
const requestId = '00000000-0000-4000-8000-000000000004'
const participant = '00000000-0000-4000-8000-000000000005'
const scope = { principalId: 'human', organizationId: org, workspaceId: null }
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
const token = () => encode({alg:'RS256',typ:'maestro-access+jwt',kid:'synthetic'}) + '.' + encode({iss:'dooers-service-core',aud:'dooers-service-maestro',sub:'human',user_id:'human',organization_id:org,workspace_id:null,actor_type:'human',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+300,jti:requestId,session_ref:'synthetic',session_version:1,scopes:['messages:write']}) + '.c3ludGhldGlj'
const caps = { protocol_version:1, schema_version:1, server_version:'0.0.0', history_authority:'maestro', capabilities:['messages.text'] }
const received = []
const server = createServer(async (req, res) => {
  assert.match(req.headers.authorization, /^Bearer /)
  let body = ''; for await (const part of req) body += part
  received.push({method:req.method,url:req.url,key:req.headers['idempotency-key'],body:body ? JSON.parse(body) : null})
  res.setHeader('content-type','application/json')
  if (req.url === '/custom/v7/capabilities') { res.end(JSON.stringify(caps)); return }
  assert.equal(req.url,'/custom/v7/threads/'+thread+'/events')
  const input = JSON.parse(body)
  assert.equal(req.headers['idempotency-key'],input.client_event_id)
  res.end(JSON.stringify({status:'persisted',duplicate:false,cursor:'opaque',event:{event_id:eventId,thread_id:thread,sequence:'9007199254740993',schema_version:1,type:'message.created',actor:{kind:'human',principal_id:'human',participant_id:participant,display_name:'Human'},payload:{content:input.content,mentions:[],client_event_id:input.client_event_id},created_at:new Date().toISOString(),causation_event_id:null,root_event_id:eventId}}))
})
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
const endpoint = 'http://127.0.0.1:'+server.address().port
try {
 for (const api of [esm,cjs]) {
  const config = {mode:'maestro',endpoint,apiPrefix:'/custom/v7',allowInsecureLocalhost:true,transport:'http',scope,authToken:token()}
  const client = new api.MaestroClient(config)
  try {
   await client.connect()
   const intent = client.prepareMessage({threadId:thread,content:[{type:'text',text:'Installed package'}]})
   const result = await client.send(intent)
   assert.equal(result.clientEventId,intent.clientEventId)
   assert.equal(result.event.sequence,'9007199254740993')
   assert.equal(client.publications.getSnapshot().events.length,1)
   assert.equal(client.store.getThread(thread).eventIds.length,1)
   assert.equal(client.store.getThread(thread).commandsByKey[intent.clientEventId].state,'persisted')
   assert.equal(client.store.getThread(thread).appliedSequence,'0')
   assert.equal(client.store.getThread(thread).resumeCursor,null)
   assert.equal(client.publications.get(thread,intent.clientEventId).state,'persisted')
   assert.equal(await client.retry(thread,intent.clientEventId),result)
  } finally { client.dispose() }
  // E07-05: exercise built ESM/CJS clients, not source aliases.
  for (const order of ['live-before-timeout','live-after-timeout','rejected']) {
   class ProofSocket {
    readyState=0; onopen=null; onmessage=null; onclose=null; onerror=null; sent=[]
    constructor(){queueMicrotask(()=>{this.readyState=1;this.onopen?.(new Event('open'))})}
    close(){this.readyState=3}
    receive(frame){this.onmessage?.(new MessageEvent('message',{data:JSON.stringify(frame)}))}
    send(raw){const f=JSON.parse(raw);this.sent.push(f);if(f.type==='connect')queueMicrotask(()=>this.receive({id:f.id,type:'ack',payload:{status:'connected',connection_id:requestId,protocol_version:1,server_version:'0.0.0',history_authority:'maestro',capabilities:['messages.text','history.replay'],expires_at:new Date(Date.now()+300000).toISOString()}}));if(f.type==='thread.subscribe')queueMicrotask(()=>this.receive({id:f.id,type:'ack',payload:{status:'subscribed',subscription_id:participant,replay_watermark:'0',replay_mode:'snapshot'}}))}
   }
   let socket
   const proof=new api.MaestroClient({...config,endpoint:'https://maestro.example',transport:'websocket',requestTimeoutMs:100,socketFactory:()=>socket=new ProofSocket()})
   try {
    await proof.connect();await proof.subscribeThread(thread)
    const intention=proof.prepareMessage({threadId:thread,content:[{type:'text',text:'Retained proof'}]})
    const sending=proof.send(intention).catch(e=>e);const command=socket.sent.at(-1)
    if(order==='rejected'){
     socket.receive({id:command.id,type:'error',payload:{code:'VALIDATION_FAILED',message:'Fixture rejected',retryable:false,request_id:requestId}});await sending
     assert.equal(proof.store.getThread(thread).optimisticByKey[intention.clientEventId].content[0].text,'Retained proof')
    }else{
     if(order==='live-after-timeout')assert.equal((await sending).publicationState,'unknown')
     const event={event_id:eventId,thread_id:thread,sequence:'1',schema_version:1,type:'message.created',actor:{kind:'human',principal_id:'human',participant_id:participant,display_name:'Human'},payload:{content:intention.content,mentions:[],client_event_id:intention.clientEventId},created_at:new Date().toISOString(),causation_event_id:null,root_event_id:null}
     socket.receive({type:'event.append',payload:{subscription_id:participant,event,cursor:'proof-cursor'}})
     await sending
     assert.equal(proof.publications.get(thread,intention.clientEventId).state,'persisted')
     assert.equal((await proof.retry(thread,intention.clientEventId)).eventId,eventId)
     assert.equal(socket.sent.filter(f=>f.type==='message.publish').length,1)
    }
    proof.reset();assert.deepEqual(proof.store.getSnapshot().threads,{})
   } finally {proof.dispose()}
  }
  // E09-04: shipped store and hook exports, independent of source aliases.
  const streamStore = new api.MaestroStore(scope)
  const execution = '00000000-0000-4000-8000-000000000020'
  const agent = '00000000-0000-4000-8000-000000000080'
  streamStore.observeThread({threadId:thread,mode:'maestro',organizationId:org,scopeKind:'personal',workspaceId:null,title:'Synthetic',state:'active',version:1,participants:[{participantId:participant,principalId:agent,instanceAgentId:agent,displayName:'Agent',kind:'agent',role:'member',state:'active',joinedSequence:'1',leftSequence:null,capabilities:[],availability:'available'}],permissions:{read:true,write:true,manage:true,supervise:true,export:true,cancel:true,feedback:true},capabilities:['stream.delta'],lastSequence:'1',cursor:'cursor-1',supervisionPolicy:'none',policyVersion:1,createdAt:'2026-10-13T15:00:00Z',updatedAt:'2026-10-13T15:00:00Z'})
  const start={event_id:eventId,thread_id:thread,sequence:'1',schema_version:1,type:'execution.started',actor:{kind:'agent',principal_id:agent,instance_agent_id:agent,participant_id:participant,display_name:'Agent'},payload:{execution_id:execution,delivery_id:requestId,participant_id:participant,phase_id:'initial',state:'running',outcome:null,reason_code:null,deadline_at:'2026-10-13T15:05:00Z',completed_at:null},created_at:'2026-10-13T15:00:00Z',causation_event_id:null,root_event_id:null}
  streamStore.append(thread,api.toMaestroNetworkEvent(start),'cursor-1');streamStore.caughtUp(thread,'1','cursor-1')
  const delta={thread_id:thread,participant_id:participant,execution_id:execution,output_id:'output:0',chunk_index:0,delta:'hello',ephemeral:true}
  streamStore.streamDelta(delta);assert.equal(Object.keys(streamStore.getThread(thread).streamsByKey).length,0)
  streamStore.setStreamCapability(true);streamStore.streamDelta(delta);streamStore.streamDelta(delta)
  assert.equal(streamStore.getThread(thread).streamsByKey[api.maestroStreamKey(execution,'output:0')].text,'hello')
  assert.equal(streamStore.getThread(thread).appliedSequence,'1');assert.equal(streamStore.getThread(thread).eventIds.length,1)
  const final={...start,event_id:requestId,sequence:'2',type:'message.created',execution_id:execution,output_id:'output:0',payload:{content:[{type:'text',text:'durable'}],mentions:[],execution_id:execution,output_id:'output:0'}}
  streamStore.append(thread,api.toMaestroNetworkEvent(final),'cursor-2');streamStore.streamDelta({...delta,chunk_index:1})
  assert.equal(Object.keys(streamStore.getThread(thread).streamsByKey).length,0);assert.equal(streamStore.getThread(thread).eventIds.length,2)
  streamStore.streamDelta({...delta,output_id:'output:1',delta:'é'.repeat(10000)});assert.equal(Object.keys(streamStore.getThread(thread).streamsByKey).length,0)
  assert.equal(api.maestroStreamLimits.deltaBytes,16384)
  const store = new api.MaestroStore(scope)
  const makeEvent = n => ({event_id:'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),thread_id:thread,sequence:String(n),schema_version:1,type:'message.created',actor:{kind:'human',principal_id:'human',participant_id:participant,display_name:'Human'},payload:{content:[{type:'text',text:'Replay '+n}],mentions:[],client_event_id:'replay-'+n},created_at:'2026-10-13T15:00:00Z',causation_event_id:null,root_event_id:eventId})
  for(let offset=0;offset<601;offset+=100) {
   const end=Math.min(offset+100,601)
   store.page(thread,Array.from({length:end-offset},(_,i)=>api.toMaestroNetworkEvent(makeEvent(offset+i+1))),'601',end<601?'cursor-'+end:null,end<601)
  }
  assert.equal(store.caughtUp(thread,'601','cursor-601'),true)
  store.append(thread,api.toMaestroNetworkEvent(makeEvent(603)),'cursor-603')
  assert.equal(store.getThread(thread).resumeCursor,'cursor-601')
  store.append(thread,api.toMaestroNetworkEvent({...makeEvent(602),type:'future.changed',payload:{display:'future'}}),'cursor-602')
  assert.equal(store.getThread(thread).resumeCursor,'cursor-603')
  assert.equal(store.getThread(thread).eventIds.length,603)
  assert.equal(api.compareMaestroSequences('9007199254740993','9007199254740992'),1)
  const stateJson=JSON.stringify(store.getSnapshot()); assert.match(stateJson,/future.changed/)
  function HookConsumer() { const value=api.useMaestroThread(thread); const members=api.useMaestroParticipants(thread); const execution=api.useMaestroExecutions(thread); const streams=api.useMaestroStreams(thread); assert.equal(streams.streams.length,0); assert.equal(streams.resyncRequired,false); return React.createElement('b',null,String(value.state===undefined)+':'+members.length+':'+execution.hasPendingWork) }
  assert.match(renderToString(React.createElement(api.MaestroProvider,{config},React.createElement(HookConsumer))),/true:0:false/)
  const content = renderToString(React.createElement(api.MaestroProvider,{config},React.createElement('span',null,'isolated')))
  assert.match(content,/isolated/)
 }
 assert.equal(received.length,4)
 console.log(JSON.stringify({installed:true,esm:true,cjs:true,legacy:true,loopbackHttp:true,react:React.version,ssr:true,normalizedReplay:603,contiguousCursor:true,threadHooks:true,canonicalLiveProofs:2,rejectedDraftRecovery:true,provisionalStreams:true,streamHooks:true}))
} finally { await new Promise(resolve => server.close(resolve)) }
`
try {
  const [packed] = JSON.parse(run(['pack','--ignore-scripts','--json','--pack-destination',temp], root))
  assert(!packed.files.some(f => /(^|\/)(\.env|node_modules|tests|src)\//.test(f.path)))
  const packageSha = createHash('sha256').update(readFileSync(path.join(temp,packed.filename))).digest('hex')
  const observations = []
  for (const version of ['18.3.1','19.2.4']) {
    const dir = path.join(temp, 'react-'+version)
    execFileSync('mkdir',['-p',dir])
    writeFileSync(path.join(dir,'package.json'), JSON.stringify({private:true,type:'module'}))
    run(['install','--offline','--ignore-scripts','--no-audit','--no-fund',path.join(temp,packed.filename),'react@'+version,'react-dom@'+version],dir)
    writeFileSync(path.join(dir,'smoke.mjs'),source)
    observations.push(JSON.parse(execFileSync(process.execPath,['smoke.mjs'],{cwd:dir,encoding:'utf8'})))
    writeFileSync(path.join(dir,'consumer.ts'), `import { MaestroClient, MaestroProvider, MaestroStore, useMaestroThread, useMaestroExecutions, useMaestroStreams, maestroStreamKey, type MaestroStream, type MaestroSendInput, type MaestroThreadState } from 'dooers-agents-client/maestro'\nimport { AgentServerClient } from 'dooers-agents-client'\nconst input: MaestroSendInput = {threadId:'id',content:[{type:'text',text:'hello'}]}\nconst state: MaestroThreadState | undefined = undefined\nvoid [MaestroClient,MaestroProvider,MaestroStore,useMaestroThread,useMaestroExecutions,AgentServerClient,input,state,useMaestroStreams,maestroStreamKey]
const stream: MaestroStream | undefined = undefined
void stream\n`)
    execFileSync(process.execPath,[path.join(root,'node_modules/typescript/bin/tsc'),'--noEmit','--strict','--skipLibCheck','--module','NodeNext','--moduleResolution','NodeNext','--target','ES2022','--lib','ES2022,DOM','consumer.ts'],{cwd:dir,stdio:'pipe'})
    const browser = await build({stdin:{contents:"export * from 'dooers-agents-client/maestro'",resolveDir:dir},bundle:true,platform:'browser',format:'esm',write:false,metafile:true,logLevel:'silent'})
    assert.equal(Object.values(browser.metafile.outputs).flatMap(o=>o.imports).length,0)
    assert(!/from\s*["']node:|require\(["'](?:node:|crypto)/.test(browser.outputFiles[0].text))
    assert(!Object.keys(browser.metafile.inputs).some(p=>/\/identity\.|\/delivery\./.test(p)))
  }
  console.log(JSON.stringify({package_sha256:packageSha,types:true,browser:true,observations}))
} finally { rmSync(temp,{recursive:true,force:true}) }
