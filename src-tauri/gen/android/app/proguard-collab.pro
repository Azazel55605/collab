-keep class com.azazel.collab.companion.CollabTokenStore {
    public static java.lang.String storeRefreshToken(android.content.Context, java.lang.String, java.lang.String);
    public static java.lang.String readRefreshToken(android.content.Context, java.lang.String);
    public static java.lang.String deleteRefreshToken(android.content.Context, java.lang.String);
}

-keep class com.azazel.collab.companion.CollabReplicaKeyStore {
    public static java.lang.String storeKey(android.content.Context, java.lang.String, java.lang.String);
    public static java.lang.String readKey(android.content.Context, java.lang.String);
    public static java.lang.String deleteKey(android.content.Context, java.lang.String);
}

# Rust resolves these Kotlin objects and their @JvmStatic methods by their exact
# JVM names. Debug builds do not run R8, but release/AAB builds do; allowing R8
# to rename these methods breaks notifications and background scheduling only in
# the Play build.
-keep class com.azazel.collab.companion.CollabBackgroundBridge { *; }
-keep class com.azazel.collab.companion.CollabBackgroundProbe { *; }
-keep class com.azazel.collab.companion.CollabBackgroundScheduler { *; }
-keep class com.azazel.collab.companion.CollabContentUri { *; }
-keep class com.azazel.collab.companion.CollabNotificationBridge { *; }
-keep class com.azazel.collab.companion.CollabNotificationScheduler { *; }
-keep class com.azazel.collab.companion.CollabWidgetBridge { *; }
