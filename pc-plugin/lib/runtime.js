import path from 'node:path';
import {existsSync} from 'node:fs';

export function resolveDshBin(configured,{executable=process.execPath,resources=process.resourcesPath,local=process.env.LOCALAPPDATA,exists=existsSync,platform=process.platform}={}){
  if(configured)return String(configured);
  const p=platform==='win32'?path.win32:path;
  const roots=[resources,p.join(p.dirname(executable),'resources')];
  if(local)roots.push(p.join(local,'Programs','DeepSeek Harness','resources'),p.join(local,'Programs','DeepSeekHarness','resources'));
  for(const root of roots.filter(Boolean)){
    const file=p.join(root,'runtime','cli','bin',platform==='win32'?'dsh.cmd':'dsh');
    if(exists(file))return file;
  }
  return 'dsh';
}
export function serveRetryDelay(failures){return Math.min(15*60*1000,30000*2**Math.min(failures,5));}
