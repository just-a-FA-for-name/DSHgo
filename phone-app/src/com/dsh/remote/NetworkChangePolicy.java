package com.dsh.remote;

/** Select by effective physical network, not by the callback that woke us up. */
final class NetworkChangePolicy {
    static final int INITIAL=1, PATH=2, DNS=4, VALIDATION=8;
    private boolean initialized;
    private long id;
    private boolean validated;
    private String dns="";
    int update(long nextId,boolean nextValidated,String nextDns){
        int flags=!initialized?INITIAL:0;
        if(initialized&&id!=nextId)flags|=PATH;
        if(initialized&&!dns.equals(nextDns))flags|=DNS;
        if(initialized&&validated!=nextValidated)flags|=VALIDATION;
        initialized=true;id=nextId;validated=nextValidated;dns=nextDns;
        return flags;
    }
}
