package com.dsh.remote;

import java.net.URI;
/** Explicit HTTP compatibility is limited to loopback, tailnet and private LAN. */
public final class EndpointPolicy {
    public static boolean allowsCleartext(String value){
        try {
            URI uri=new URI(value);String scheme=uri.getScheme(),host=uri.getHost();
            if(!"http".equalsIgnoreCase(scheme)&&!"ws".equalsIgnoreCase(scheme))return true;
            if(host==null||uri.getRawUserInfo()!=null)return false;
            host=host.toLowerCase(java.util.Locale.ROOT);
            if(host.startsWith("[")&&host.endsWith("]"))host=host.substring(1,host.length()-1);
            if(host.equals("localhost")||host.equals("::1")||host.endsWith(".ts.net"))return true;
            if(host.startsWith("fd7a:115c:a1e0:"))return true;
            String[] parts=host.split("\\.");if(parts.length!=4)return false;
            int[] ip=new int[4];for(int i=0;i<4;i++){if(!parts[i].matches("[0-9]{1,3}"))return false;ip[i]=Integer.parseInt(parts[i]);if(ip[i]>255)return false;}
            return ip[0]==127||ip[0]==10||(ip[0]==192&&ip[1]==168)||(ip[0]==172&&ip[1]>=16&&ip[1]<=31)||(ip[0]==100&&ip[1]>=64&&ip[1]<=127);
        }catch(Exception e){return false;}
    }
}
