// Isolated development Host only. Events enter the real ChatController.
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
exports.run = async () => {
  const root = await fs.realpath(process.env.AI_AGENTS_GUI_FIXTURE_ROOT || '');
  if (!root.startsWith('/private/tmp/ai-agents-gui-acceptance-')) throw Error('Disposable host required');
  const receipt = JSON.parse(await fs.readFile(path.join(root,'session.json'),'utf8'));
  if (await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath) !== receipt.paths.workspace) throw Error('Workspace mismatch');
  const {sidebar} = await vscode.extensions.getExtension('y3162.ai-agents').activate();
  await vscode.commands.executeCommand('ai-agents.chat.focus');
  const deadline=Date.now()+30000; while(!sidebar.isReady()){if(Date.now()>deadline)throw Error('Webview unavailable');await new Promise(r=>setTimeout(r,50));}
  await sidebar.openPanel('chat');
  const controller=sidebar.controller;
  let emit, finish;
  controller.factory=async()=>({sessionId:'fixture-subagent-session',async dispose(){},async run(_prompt,signal,update){emit=update;await new Promise(resolve=>{finish=resolve;signal.addEventListener('abort',resolve,{once:true});});}});
  const snapshot=path.join(root,'subagent-snapshot.json');
  try { const saved=JSON.parse(await fs.readFile(snapshot,'utf8')); controller.restoreSnapshot(saved,'fixture-subagent-session'); sidebar.flushNow(); } catch(e) { if(e.code!=='ENOENT')throw e; }
  await fs.writeFile(path.join(root,'subagent-restore-ready'),JSON.stringify({at:Date.now(),restored:controller.snapshot().subagents.length>0}));
  let previous='';
  while(Date.now()<deadline+1200000){
    let raw='';try{raw=await fs.readFile(path.join(root,'subagent-restore-request.json'),'utf8')}catch(e){if(e.code!=='ENOENT')throw e}
    if(raw && raw!==previous){previous=raw;const req=JSON.parse(raw);
      if(req.action==='start'){emit=undefined;void controller.send('subagent fixture parent');const end=Date.now()+15000;while(!emit&&Date.now()<end)await new Promise(r=>setTimeout(r,50));if(!emit)throw Error('Parent did not start');}
      else if(req.action==='event'){
        if(!emit)throw Error('Parent not started');
        if(req.child==='wait')emit({id:'wait',role:'status',text:'',meta:{type:'subagentWait',subagentWait:{waiting:req.status==='running'}}});
        else emit({id:`child-${req.child}`,role:'status',text:req.child,meta:{type:'subagent',subagent:{id:req.child,name:`Fixture ${req.child}`,status:req.status,background:false,task:`Task ${req.child}`,...(req.status==='completed'?{resultPreview:`${req.child} result`}:{}),...(req.status==='error'?{error:'fixture failure'}:{})}}});
      } else if(req.action==='finish'){emit({id:'answer',role:'assistant',text:'Parent resumed and completed',final:true});finish();const end=Date.now()+15000;while(controller.snapshot().busy&&Date.now()<end)await new Promise(r=>setTimeout(r,50));}
      else if(req.action==='save')await fs.writeFile(snapshot,JSON.stringify(controller.snapshot()));
      else if(req.action==='inspect') { /* return current Controller state */ }
      else throw Error('Invalid action');
      sidebar.flushNow();
      await fs.writeFile(path.join(root,'subagent-restore-result.json'),JSON.stringify({id:req.id,action:req.action,state:controller.snapshot()}));
    }
    await new Promise(r=>setTimeout(r,50));
  }
};
