// Isolated Host only. The fake backend implements the Plan event capability;
// normal Codex CLI capabilities remain untouched.
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
exports.run = async () => {
 const root=await fs.realpath(process.env.AI_AGENTS_GUI_FIXTURE_ROOT||'');
 if(!root.startsWith('/private/tmp/ai-agents-gui-acceptance-')) throw Error('Disposable host required');
 const receipt=JSON.parse(await fs.readFile(path.join(root,'session.json'),'utf8'));
 if(await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath)!==receipt.paths.workspace) throw Error('Workspace mismatch');
 const {sidebar}=await vscode.extensions.getExtension('y3162.ai-agents').activate();
 await vscode.commands.executeCommand('ai-agents.chat.focus');
 const end=Date.now()+30000;while(!sidebar.isReady()){if(Date.now()>end)throw Error('Webview not ready');await new Promise(r=>setTimeout(r,50));}
 const controller=sidebar.controller;
 sidebar.controls.codex={...sidebar.controls.codex,backend:'app-server'};
 sidebar.controllerControls.set(controller,{...sidebar.controls.codex});
 controller.factory=async()=>({sessionId:'fixture-plan-backend',async setMode(){},async setModel(selection){await fs.writeFile(path.join(root,'plan-selected-model.json'),JSON.stringify(selection));},async dispose(){},async run(prompt,signal,emit,_extras,turn){
  await fs.appendFile(path.join(root,'plan-invocations.jsonl'),JSON.stringify({prompt,intent:turn.intent,mode:turn.mode})+'\n');
  if(turn.intent==='plan'||turn.intent==='revise'){
   emit({id:`plan-${turn.intent}`,role:'status',text:'',meta:{type:'plan',plan:{name:'Fixture Plan',markdown:turn.intent==='revise'?'## Revised\n- Include requested change':'## Steps\n- Implement requested change',source:'app-server-plan'}}});
   emit({id:`answer-${turn.intent}`,role:'assistant',text:'Fixture plan complete'}); return;
  }
  if(turn.intent==='build'){
   await fs.writeFile(path.join(root,'plan-build-started'),'started');
   while(!signal.aborted){
    try { const outcome=(await fs.readFile(path.join(root,'plan-build-outcome'),'utf8')).trim(); await fs.rm(path.join(root,'plan-build-outcome')); if(outcome==='fail')throw Error('Fixture build failure');if(outcome==='complete')return; } catch(e){if(e.code!=='ENOENT')throw e;}
    await new Promise(r=>setTimeout(r,50));
   }
  }
 }});
 await sidebar.openPanel('chat');sidebar.postState();
 await fs.writeFile(path.join(root,'plan-flow-ready'),'ready');
 while(Date.now()<end+1200000){
  const s=controller.snapshot();
  await fs.writeFile(path.join(root,'plan-flow-state.json'),JSON.stringify({phase:s.plan.phase,busy:s.busy,status:s.status,mode:sidebar.registry.mode(),revision:s.plan.current?.revision,markdown:s.plan.current?.markdown,turns:s.turns.map(t=>({mode:t.mode,intent:t.intent,status:t.status}))}));
  await new Promise(r=>setTimeout(r,50));
 }
 throw Error('Plan fixture timed out');
};
