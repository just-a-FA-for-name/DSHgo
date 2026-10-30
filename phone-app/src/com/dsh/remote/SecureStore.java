package com.dsh.remote;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import java.net.NetworkInterface;
import android.os.Build;
import android.provider.Settings;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Log;

import org.json.JSONArray;

import android.os.ParcelFileDescriptor;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Enumeration;
import java.util.HashSet;
import java.util.Set;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * libtailscale.AppContext implementation: durable encrypted key/value store
 * backed by the Android Keystore plus the small device facts the engine asks
 * for. Nothing here leaves the device.
 */
public final class SecureStore implements libtailscale.AppContext {

    private static final String TAG = "DSHSecureStore";
    private static final String PREFS = "dsh_ts_store";
    private static final String INDEX = "dsh_ts_keys";
    private static final String KEY_ALIAS = "dsh_ts_master";
    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";

    private final Context ctx;
    private final SharedPreferences prefs;
    private final SharedPreferences index;

    public SecureStore(Context ctx) {
        this.ctx = ctx;
        this.prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        this.index = ctx.getSharedPreferences(INDEX, Context.MODE_PRIVATE);
    }

    // ---------------------------------------------------- encrypted store

    @Override
    public void encryptToPref(String key, String value) throws Exception {
        byte[] ct = crypto(true, value.getBytes(StandardCharsets.UTF_8));
        prefs.edit().putString(key, android.util.Base64.encodeToString(ct, android.util.Base64.NO_WRAP)).apply();
        Set<String> keys = new HashSet<>(index.getStringSet("keys", Collections.<String>emptySet()));
        keys.add(key);
        index.edit().putStringSet("keys", keys).apply();
    }

    @Override
    public String decryptFromPref(String key) throws Exception {
        String b64 = prefs.getString(key, null);
        if (b64 == null) return "";
        return new String(crypto(false, android.util.Base64.decode(b64, android.util.Base64.NO_WRAP)),
            StandardCharsets.UTF_8);
    }

    @Override
    public String getStateStoreKeysJSON() {
        JSONArray arr = new JSONArray();
        for (String k : index.getStringSet("keys", Collections.<String>emptySet())) {
            arr.put(k.startsWith("statestore-") ? k.substring("statestore-".length()) : k);
        }
        return arr.toString();
    }

    // ------------------------------------------------------ device facts

    @Override
    public void log(String tag, String line) {
        Log.i("DSHVPN/" + tag, line);
    }

    @Override
    public String getOSVersion() {
        return Build.VERSION.RELEASE == null ? "" : Build.VERSION.RELEASE;
    }

    @Override
    public long getSDKInt() {
        return Build.VERSION.SDK_INT;
    }

    @Override
    public String getDeviceName() {
        try {
            String n = Settings.Global.getString(ctx.getContentResolver(), "device_name");
            if (n != null && !n.isEmpty()) return n;
        } catch (Exception ignored) {}
        return Build.MODEL == null ? "Android" : Build.MODEL;
    }

    @Override
    public String getInstallSource() {
        try {
            String s = ctx.getPackageManager().getInstallerPackageName(ctx.getPackageName());
            return s == null ? "sideload" : s;
        } catch (Exception e) {
            return "sideload";
        }
    }

    @Override
    public boolean shouldUseGoogleDNSFallback() {
        return true;
    }

    @Override
    public boolean isChromeOS() {
        return false;
    }

    @Override
    public boolean isClientLoggingEnabled() {
        return Prefs.get(ctx, "client_logging", false);
    }

    @Override
    public String getInterfacesAsJson() {
        StringBuilder sb = new StringBuilder("[");
        try {
            Enumeration<NetworkInterface> en = NetworkInterface.getNetworkInterfaces();
            boolean firstIface = true;
            for (NetworkInterface ni : Collections.list(en)) {
                if (!firstIface) sb.append(',');
                firstIface = false;
                sb.append("{\"name\":\"").append(ni.getName())
                    .append("\",\"index\":").append(ni.getIndex())
                    .append(",\"mtu\":").append(ni.getMTU() > 0 ? ni.getMTU() : 1500)
                    .append(",\"up\":").append(ni.isUp())
                    .append(",\"broadcast\":").append(!ni.isLoopback() && !ni.isPointToPoint())
                    .append(",\"loopback\":").append(ni.isLoopback())
                    .append(",\"pointToPoint\":").append(ni.isPointToPoint())
                    .append(",\"multicast\":").append(ni.supportsMulticast())
                    .append(",\"addrs\":[");
                boolean firstAddr = true;
                for (java.net.InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    if (!firstAddr) sb.append(',');
                    firstAddr = false;
                    String ip = ia.getAddress().getHostAddress();
                    int pct = ip.indexOf('%');
                    if (pct > 0) ip = ip.substring(0, pct);
                    sb.append("{\"ip\":\"").append(ip)
                        .append("\",\"prefixLen\":").append(ia.getNetworkPrefixLength())
                        .append('}');
                }
                sb.append("]}");
            }
        } catch (Exception ignored) {}
        sb.append(']');
        return sb.toString();
    }

    @Override
    public String getPlatformDNSConfig() {
        try {
            ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            Network network = physicalNetwork(cm);
            android.net.LinkProperties lp = network == null ? null : cm.getLinkProperties(network);
            if (lp == null) return "";
            StringBuilder dns = new StringBuilder();
            for (java.net.InetAddress address : lp.getDnsServers()) {
                if (dns.length() > 0) dns.append(' ');
                dns.append(address.getHostAddress());
            }
            return dns + "\n" + (lp.getDomains() == null ? "" : lp.getDomains());
        } catch (Exception e) { return ""; }
    }

    static Network physicalNetwork(ConnectivityManager cm) {
        Network best = null;
        int bestScore = -1;
        Network active = cm.getActiveNetwork();
        for (Network network : cm.getAllNetworks()) {
            NetworkCapabilities caps = cm.getNetworkCapabilities(network);
            if (caps == null || !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
                || !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) continue;
            int score = (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) ? 100 : 0)
                + (network.equals(active) ? 20 : 0)
                + (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ? 10 : 0);
            if (score > bestScore) { best = network; bestScore = score; }
        }
        return best;
    }

    @Override
    public boolean bindSocketToNetwork(int fd) {
        try {
            ConnectivityManager cm =
                (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            Network best = physicalNetwork(cm);
            if (best == null) { Diagnostics.socketBinding(ctx,2); return false; }
            // Duplicate ownership through the public API. Closing the wrapper
            // must not close Go's original descriptor. No hidden-field reflection.
            try (ParcelFileDescriptor duplicate=ParcelFileDescriptor.fromFd(fd)) {
                best.bindSocket(duplicate.getFileDescriptor());
            }
            Diagnostics.socketBinding(ctx,1);
            return true;
        } catch (Exception e) {
            Diagnostics.socketBinding(ctx,3);
            return false;
        }
    }

    // -------------------------------------------------- MDM / syspolicy

    @Override
    public boolean getSyspolicyBooleanValue(String key) {
        return Prefs.get(ctx, "syspolicy_" + key, false);
    }

    @Override
    public String getSyspolicyStringValue(String key) {
        return Prefs.get(ctx).getString("syspolicy_" + key, "");
    }

    @Override
    public String getSyspolicyStringArrayJSONValue(String key) {
        return "[]";
    }

    @Override
    public byte[] getUserCACertsPEM() {
        return new byte[0];
    }

    // ----------------------------------------------- hardware attestation

    @Override
    public boolean hardwareAttestationKeySupported() {
        return false;
    }

    @Override
    public String hardwareAttestationKeyCreate() throws Exception {
        throw new Exception("hardware attestation not supported");
    }

    @Override
    public void hardwareAttestationKeyLoad(String id) throws Exception {
        throw new Exception("hardware attestation not supported");
    }

    @Override
    public byte[] hardwareAttestationKeyPublic(String id) throws Exception {
        throw new Exception("hardware attestation not supported");
    }

    @Override
    public void hardwareAttestationKeyRelease(String id) {}

    @Override
    public byte[] hardwareAttestationKeySign(String id, byte[] blob) throws Exception {
        throw new Exception("hardware attestation not supported");
    }

    // -------------------------------------------------------- crypto

    private SecretKey getOrCreateKey() throws Exception {
        KeyStoreHolder.ensure();
        java.security.KeyStore ks = java.security.KeyStore.getInstance(ANDROID_KEYSTORE);
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) {
            return (SecretKey) ks.getKey(KEY_ALIAS, null);
        }
        KeyGenerator kg = KeyGenerator.getInstance("AES", ANDROID_KEYSTORE);
        kg.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .build());
        return kg.generateKey();
    }

    private byte[] crypto(boolean encrypt, byte[] data) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        if (encrypt) {
            c.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
            byte[] iv = c.getIV();
            byte[] ct = c.doFinal(data);
            byte[] out = new byte[iv.length + ct.length];
            System.arraycopy(iv, 0, out, 0, iv.length);
            System.arraycopy(ct, 0, out, iv.length, ct.length);
            return out;
        }
        byte[] iv = new byte[12];
        System.arraycopy(data, 0, iv, 0, 12);
        c.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(128, iv));
        return c.doFinal(data, 12, data.length - 12);
    }

    static final class KeyStoreHolder {
        static void ensure() {}
    }
}
