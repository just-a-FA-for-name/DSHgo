const {test}=require('node:test');
const assert=require('node:assert/strict');

test('desktop CLI discovery prefers the runtime shipped with the actual executable',async()=>{
 const {resolveDshBin}=await import('./lib/runtime.js');
 const candidate='D:\\DSH With Spaces\\resources\\runtime\\cli\\bin\\dsh.cmd';
 const options={platform:'win32',executable:'D:\\DSH With Spaces\\DSH.exe',local:'C:\\Local',exists:p=>p===candidate};
 assert.equal(resolveDshBin(undefined,options),candidate);
 assert.equal(resolveDshBin('E:\\custom\\dsh.cmd',options),'E:\\custom\\dsh.cmd');
 assert.equal(resolveDshBin(undefined,{...options,exists:()=>false}),'dsh');
});
test('Serve retry backoff is bounded and does not hammer a permission failure every 30 seconds',async()=>{
 const {serveRetryDelay}=await import('./lib/runtime.js');
 assert.equal(serveRetryDelay(1),60000);
 assert.equal(serveRetryDelay(2),120000);
 assert.equal(serveRetryDelay(99),900000);
});
