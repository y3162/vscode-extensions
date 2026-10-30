// Isolated host only. Uses a real mock-CLI conversation; only the Plan document
// is synthetic. Plan persistence and session resume remain production paths.
const vscode=require('vscode');const fs=require('node:fs/promises');const path=require('node:path');
exports.run=async()=>{
 const root=await fs.realpath(process.env.AI_AGENTS_GUI_FIXTURE_ROOT||'');if(!root.startsWith('/private/tmp/ai-agents-gui-acceptance-'))throw Error('Disposable host required');
 const receipt=JSON.parse(await fs.readFile(path.join(root,'session.json'),'utf8'));if(await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath)!==receipt.paths.workspace)throw Error('Workspace mismatch');
 const {sidebar}=await vscode.extensions.getExtension('y3162.ai-agents').activate();await vscode.commands.executeCommand('ai-agents.chat.focus');
 const deadline=Date.now()+30000;while(!sidebar.isReady()){if(Date.now()>deadline)throw Error('Webview not ready');await new Promise(r=>setTimeout(r,50));}
 await fs.writeFile(path.join(root,'plan-restore-ready'),new Date().toISOString());let handled='';
 while(Date.now()<deadline+1200000){
  let raw='';try{raw=await fs.readFile(path.join(root,'plan-restore-request.json'),'utf8')}catch(e){if(e.code!=='ENOENT')throw e}
  if(raw&&raw!==handled){handled=raw;const req=JSON.parse(raw);if(req.action==='stage'){
   const c=sidebar.controller;const id=c.sessionId();if(!id||!id.startsWith('fixture-thread-'))throw Error('Real fixture CLI session required');
   const turnId=c.snapshot().turns[0]?.id;if(!turnId)throw Error('Fixture turn missing');
   c.restorePlan({phase:'ready',revisions:[],current:{id:'fixture-restored-plan',revision:1,name:'Restored Fixture Plan',markdown:'## Verification\n- Retain this plan after reload',todos:[],source:'assistant-text',createdAt:Date.now(),sessionId:id,turnId}});
   await sidebar.flushHistory();await fs.writeFile(path.join(root,'plan-restore-result.json'),JSON.stringify({id:req.id,sessionId:id,plan:c.snapshot().plan,backend:sidebar.controllerControls.get(c).backend}));
  }}
  await new Promise(r=>setTimeout(r,50));
 }
};
