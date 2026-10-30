package com.dsh.remote;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;


/**
 * "Universal capture": once the tunnel is up, look at every online tailnet
 * peer and find the one that speaks the DSH workbench protocol, then return a
 * ready-to-use URL. Works regardless of how the peer is named or which port
 * the bridge is published on.
 */
public final class Discovery {

    private static final String TAG = "DSHDiscovery";
    private static final String SIGNATURE = "dsh web authentication required";

    /** Probe order: standard bridge ports first, then the raw desktop app. */
    private static final int[] PORTS = {443, 8123, 8124, 4505, 3080};

    public interface Callback {
        void onFound(String url);
        void onFailed(String reason);
    }

    public static void find(final Tunnel tunnel, final Callback cb) {
        new Thread(new Runnable() {
            @Override public void run() {
                try {
                    List<String> candidates = candidates(tunnel);
                    for (String u : candidates) {
                        if (probe(u)) {
                            cb.onFound(u);
                            return;
                        }
                    }
                    cb.onFailed("未发现可用的 DSH 服务（共探测 " + candidates.size() + " 个候选）");
                } catch (Exception e) {
                    cb.onFailed(e.getMessage());
                }
            }
        }).start();
    }

    private static List<String> candidates(Tunnel tunnel) {
        List<String> out = new ArrayList<>();
        try {
            JSONArray peers = tunnel.peers();
            for (int i = 0; i < peers.length(); i++) {
                JSONObject p = peers.optJSONObject(i);
                if (p == null) continue;
                if (!p.optBoolean("Online", true)) continue;
                String dns = Tunnel.optString(p, "DNSName");
                if (dns.endsWith(".")) dns = dns.substring(0, dns.length() - 1);
                JSONArray ips = p.optJSONArray("TailscaleIPs");
                List<String> hosts = new ArrayList<>();
                if (!dns.isEmpty()) hosts.add(dns);
                if (ips != null) {
                    for (int k = 0; k < ips.length(); k++) hosts.add(ips.optString(k));
                }
                for (String h : hosts) {
                    for (int port : PORTS) {
                        boolean tls = port == 443;
                        // Serve requires the DNS identity for SNI and certificate
                        // verification. An IP is not a valid HTTPS fallback.
                        if (tls && !h.equals(dns)) continue;
                        String authority = h.contains(":") ? "[" + h + "]" : h;
                        String base = (tls ? "https://" : "http://") + authority
                            + (tls ? "" : ":" + port) + "/";
                        if (!out.contains(base)) out.add(base);
                    }
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "candidates: " + e.getMessage());
        }
        return out;
    }

    private static boolean probe(String url) {
        HttpURLConnection c = null;
        try {
            if(!EndpointPolicy.allowsCleartext(url))return false;
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(12000);
            c.setReadTimeout(12000);
            c.setRequestMethod("GET");
            c.setInstanceFollowRedirects(false);
            int code = c.getResponseCode();
            // The DSH bridge answers unauthenticated probes with a login
            // redirect carrying its own cookie name: that is the fingerprint.
            String setCookie = c.getHeaderField("Set-Cookie");
            if (setCookie != null && setCookie.contains("dsh-auth-")) return true;
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            if (in == null) return false;
            byte[] buf = new byte[2048];
            int n = in.read(buf);
            in.close();
            if (n <= 0) return false;
            String body = new String(buf, 0, n, "UTF-8").toLowerCase();
            return body.contains(SIGNATURE)
                || body.contains("dsh-auth")
                || body.contains("等待电脑上的 dsh")
                || body.contains("deepseek harness");
        } catch (Exception e) {
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }

}
