package com.dsh.remote;
import android.content.Context;
import android.net.*;
import android.os.Build;
import java.io.*;
import java.util.zip.*;
import org.json.JSONObject;
/** Bounded numeric events only: no URLs, text, filenames or credentials. */
public final class Diagnostics {
 public static final String ENABLED="diagnostics_enabled";
 private static long lastSignal;
 private static int lastNetwork=-1;
 private static long lastConsole;
 private static long lastBind;
 private static int lastBindCode;
 public static synchronized void event(Context c,int event,long code,long count) {
  if(!Prefs.get(c,ENABLED,true)||event<1||event>20)return;
  long now=android.os.SystemClock.elapsedRealtime();
  if(event==10){if(now-lastConsole<5000)return;lastConsole=now;}
  try {
   File dir=new File(c.getFilesDir(),"diagnostics");dir.mkdirs();
   File file=new File(dir,"events-0.jsonl");
   if(file.length()>=262144){new File(dir,"events-2.jsonl").delete();new File(dir,"events-1.jsonl").renameTo(new File(dir,"events-2.jsonl"));file.renameTo(new File(dir,"events-1.jsonl"));}
   JSONObject o=new JSONObject();o.put("time",System.currentTimeMillis());o.put("event",event);o.put("code",Math.max(-100000,Math.min(100000,code)));o.put("count",Math.max(0,Math.min(2147483648L,count)));
   try(FileOutputStream out=new FileOutputStream(file,true)){out.write((o.toString()+"\n").getBytes("UTF-8"));}
  }catch(Exception ignored){}
 }
 public static synchronized void signal(Context c,int kind,long bytes,int reason){long now=android.os.SystemClock.elapsedRealtime();if(kind<1||kind>3||(kind==1&&now-lastSignal<5000))return;lastSignal=now;event(c,9,kind,bytes);if(kind==3)event(c,12,Math.max(0,Math.min(6,reason)),0);}
 public static synchronized void network(Context c,NetworkCapabilities caps){
  int type=caps==null?0:caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)?2:caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)?1:3;
  int valid=caps!=null&&caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)?1:0;
  int signature=type*2+valid;if(signature==lastNetwork)return;lastNetwork=signature;event(c,13,type,valid);
 }
 public static synchronized void socketBinding(Context c,int code){
  long now=android.os.SystemClock.elapsedRealtime();if(code==lastBindCode&&now-lastBind<30000)return;
  lastBind=now;lastBindCode=code;event(c,14,code,0);
 }
 public static synchronized void clear(Context c){for(int i=0;i<3;i++)new File(new File(c.getFilesDir(),"diagnostics"),"events-"+i+".jsonl").delete();}
 public static synchronized void export(Context c,OutputStream output)throws Exception{
  try(ZipOutputStream zip=new ZipOutputStream(output)){
   JSONObject info=new JSONObject();info.put("schema",1);info.put("app",c.getPackageManager().getPackageInfo(c.getPackageName(),0).versionName);info.put("android_api",Build.VERSION.SDK_INT);info.put("logging_enabled",Prefs.get(c,ENABLED,true));
   android.content.pm.PackageInfo web=android.webkit.WebView.getCurrentWebViewPackage();info.put("webview_version",web==null?"unknown":web.versionName);
   ConnectivityManager cm=(ConnectivityManager)c.getSystemService(Context.CONNECTIVITY_SERVICE);Network physical=SecureStore.physicalNetwork(cm);NetworkCapabilities caps=physical==null?null:cm.getNetworkCapabilities(physical);
   info.put("physical_transport",caps==null?"none":caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)?"cellular":caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)?"wifi":"other");info.put("validated",caps!=null&&caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED));
   boolean own=false;for(Network n:cm.getAllNetworks()){NetworkCapabilities nc=cm.getNetworkCapabilities(n);if(nc!=null&&nc.hasTransport(NetworkCapabilities.TRANSPORT_VPN)&&Build.VERSION.SDK_INT>=29&&nc.getOwnerUid()==android.os.Process.myUid())own=true;}info.put("own_vpn",own);boolean dnsPresent=false;
   for(Network n:cm.getAllNetworks()){NetworkCapabilities nc=cm.getNetworkCapabilities(n);if(nc==null||!nc.hasTransport(NetworkCapabilities.TRANSPORT_VPN))continue;
    if(Build.VERSION.SDK_INT>=29&&nc.getOwnerUid()!=android.os.Process.myUid())continue;
    LinkProperties lp=cm.getLinkProperties(n);if(lp!=null)for(java.net.InetAddress address:lp.getDnsServers())if("100.100.100.100".equals(address.getHostAddress()))dnsPresent=true;
   }
   info.put("magicdns_requested",true);info.put("magicdns_present",dnsPresent);
   put(zip,"environment.json",info.toString(2).getBytes("UTF-8"));
   put(zip,"说明.txt",("仅本应用状态和数值；无历史连接、域名、IP、聊天、文件名、凭证或系统日志。\n事件:1启动 2原生状态 3网页状态 4网页错误 5TLS错误 6网络可用 7网络丢失 8VPN配置 9上传(1进度/2完成/3失败) 10控制台错误(仅等级) 11主动诊断(HTTP状态/-2DNS/-11TLS/-1网络，count为毫秒) 12上传失败分类(0未知/1超时/2网络/3认证/4忙碌/5偏移/6桌面) 13物理网络(0无/1WiFi/2移动数据/3其他，count为系统验证状态)。\n新增事件:14内核 socket 绑定(1成功/2无物理网络/3失败) 15实际网络变化(bit1初始/2路径/4DNS/8验证状态，count=0隧道/1页面) 16页面加载(1资源失败/2脚本异常/3未处理Promise/4DOM就绪/5load，count仅分类数字)。\n17明文边界拒绝 18页面资源HTTP错误(count=0主文档/1插件/2入口资源)。\n网页状态:1正常 2异常 3重连 4载入 5检查 6认证失败 7限流 8服务异常。最多3份各256KiB循环保存；可关闭及清除。\n5G复现后立即导出，并说明复现时间和操作。此文件不会自动发送。\n").getBytes("UTF-8"));
   for(int i=0;i<3;i++){File f=new File(new File(c.getFilesDir(),"diagnostics"),"events-"+i+".jsonl");if(!f.isFile())continue;zip.putNextEntry(new ZipEntry(f.getName()));try(InputStream in=new FileInputStream(f)){byte[] b=new byte[8192];int n;while((n=in.read(b))!=-1)zip.write(b,0,n);}zip.closeEntry();}
  }
 }
 private static void put(ZipOutputStream z,String n,byte[] b)throws IOException{z.putNextEntry(new ZipEntry(n));z.write(b);z.closeEntry();}
}
