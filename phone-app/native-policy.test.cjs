const{test}=require('node:test');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const{execFileSync}=require('node:child_process');
test('effective-network transitions and private HTTP boundaries',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-policy-'));
 const tools=process.env.JAVA_HOME||'D:/adk/jdk17';
 const source=`package com.dsh.remote;
 public class PolicyAudit{
  static void check(boolean value){if(!value)throw new AssertionError("policy assertion failed");}
  public static void main(String[]args){
   NetworkChangePolicy policy=new NetworkChangePolicy();
   check(policy.update(100,true,"wifi-dns")==NetworkChangePolicy.INITIAL);
   for(int i=0;i<200;i++)check(policy.update(100,true,"wifi-dns")==0);
   check(policy.update(100,true,"new-dns")==NetworkChangePolicy.DNS);
   check(policy.update(100,false,"new-dns")==NetworkChangePolicy.VALIDATION);
   check((policy.update(101,true,"cell-dns")&NetworkChangePolicy.PATH)!=0);
   check((policy.update(0,false,"")&NetworkChangePolicy.PATH)!=0);
   for(String url:new String[]{"http://100.64.0.1:8124/","http://100.127.255.254/","http://192.168.1.1/","http://172.16.0.1/","http://10.1.1.1/","http://localhost/","http://127.0.0.1/","http://[::1]/","http://[fd7a:115c:a1e0::1]/","http://desktop.test.ts.net/","https://example.com/"})check(EndpointPolicy.allowsCleartext(url));
   for(String url:new String[]{"http://100.63.255.255/","http://100.128.0.1/","http://172.32.1.1/","http://8.8.8.8/","http://example.com/","http://10.0.0.1.evil.example/","http://user:secret@10.0.0.1/","http://999.1.1.1/"})check(!EndpointPolicy.allowsCleartext(url));
   System.out.println("Policy assertions passed");
  }
 }`;
 try{
 fs.writeFileSync(path.join(directory,'PolicyAudit.java'),source);
 const root=path.join(__dirname,'src/com/dsh/remote');
 execFileSync(path.join(tools,'bin/javac.exe'),['-encoding','UTF-8','-d',directory,path.join(root,'NetworkChangePolicy.java'),path.join(root,'EndpointPolicy.java'),path.join(directory,'PolicyAudit.java')],{stdio:'pipe',windowsHide:true});
 execFileSync(path.join(tools,'bin/java.exe'),['-cp',directory,'com.dsh.remote.PolicyAudit'],{stdio:'pipe',windowsHide:true});
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
