package io.github.muxin2929.hghub;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 覆盖安装完成后，系统会发 MY_PACKAGE_REPLACED：把 App 自动再拉起来一次。
 * 用户在安装界面点「完成」或者直接返回，都能回到刚更新的 App。
 */
public class UpdateReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null || intent == null) return;
        if (!Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) return;
        try {
            Intent open = new Intent(context, MainActivity.class);
            open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            context.startActivity(open);
        } catch (Exception ignored) {
            /* 拉不起来就算了，用户自己点图标也一样 */
        }
    }
}
