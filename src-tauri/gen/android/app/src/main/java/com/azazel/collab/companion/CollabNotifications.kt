package com.azazel.collab.companion

import android.Manifest
import android.app.Activity
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID
import java.util.concurrent.Executors

object CollabNotificationBridge {
  const val EXTRA_PROFILE_ID = "collabNotificationProfileId"
  const val EXTRA_NOTIFICATION_ID = "collabNotificationId"
  const val EXTRA_ACTION_TOKEN = "collabNotificationActionToken"
  const val ACTION_OPEN = "com.collab.companion.OPEN_NOTIFICATION"
  const val ACTION_APPLY = "com.collab.companion.APPLY_NOTIFICATION_ACTION"
  private const val PREFS = "collab-notification-permission"
  private const val REQUESTED_KEY = "requested"
  private const val PENDING_PROFILE_KEY = "pendingProfileId"
  private const val PENDING_NOTIFICATION_KEY = "pendingNotificationId"
  const val PERMISSION_REQUEST_CODE = 7301

  init {
    System.loadLibrary("collab_lib")
  }

  @JvmStatic external fun nativeListDue(context: Context, profileId: String): String
  @JvmStatic external fun nativeCompleteDelivery(
    context: Context,
    profileId: String,
    notificationId: String,
    error: String,
  ): String
  @JvmStatic external fun nativeApplyAction(
    context: Context,
    profileId: String,
    token: String,
  ): String
  @JvmStatic external fun nativeProfileSchedules(context: Context): String
  @JvmStatic external fun nativeRequestReconciliation(context: Context, reason: String): String
  @JvmStatic external fun nativeRegisterPushToken(
    context: Context,
    installationId: String,
    token: String,
    appVersion: String,
  ): String
  @JvmStatic external fun nativeHandlePushInvalidation(context: Context, payload: String): String

  fun persistPendingOpen(context: Context, profileId: String, notificationId: String) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit()
      .putString(PENDING_PROFILE_KEY, profileId)
      .putString(PENDING_NOTIFICATION_KEY, notificationId)
      .apply()
  }

  @JvmStatic
  fun takePendingOpen(context: Context): String? {
    val preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val profileId = preferences.getString(PENDING_PROFILE_KEY, null) ?: return null
    val notificationId = preferences.getString(PENDING_NOTIFICATION_KEY, null) ?: return null
    preferences.edit()
      .remove(PENDING_PROFILE_KEY)
      .remove(PENDING_NOTIFICATION_KEY)
      .apply()
    return JSONObject()
      .put("profileId", profileId)
      .put("notificationId", notificationId)
      .toString()
  }

  @JvmStatic
  fun permissionStatus(context: Context): String {
    if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return "denied"
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return "granted"
    if (
      ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
      PackageManager.PERMISSION_GRANTED
    ) {
      return "granted"
    }
    val activity = (context as? Activity) ?: MainActivity.currentActivity()
    if (
      activity != null &&
      ActivityCompat.shouldShowRequestPermissionRationale(activity, Manifest.permission.POST_NOTIFICATIONS)
    ) {
      return "prompt-with-rationale"
    }
    val requested = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .getBoolean(REQUESTED_KEY, false)
    return if (requested) "denied" else "prompt"
  }

  @JvmStatic
  fun requestPermission(context: Context): String {
    ensureChannels(context)
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return permissionStatus(context)
    if (permissionStatus(context) == "granted") return "granted"
    val activity = (context as? Activity) ?: MainActivity.currentActivity()
      ?: return permissionStatus(context)
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit()
      .putBoolean(REQUESTED_KEY, true)
      .apply()
    ActivityCompat.requestPermissions(
      activity,
      arrayOf(Manifest.permission.POST_NOTIFICATIONS),
      PERMISSION_REQUEST_CODE,
    )
    return "prompt"
  }

  @JvmStatic
  fun sendTest(context: Context): String? = try {
    ensureChannels(context)
    if (permissionStatus(context) != "granted") {
      "Notification permission is not granted."
    } else {
      val intent = Intent(context, MainActivity::class.java)
        .setAction(ACTION_OPEN)
      val pendingIntent = PendingIntent.getActivity(
        context,
        0,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      NotificationManagerCompat.from(context).notify(
        stableId("collab-test-notification"),
        NotificationCompat.Builder(context, CHANNEL_CALENDAR)
          .setSmallIcon(R.drawable.ic_notification)
          .setContentTitle("Collab notifications")
          .setContentText("Android notifications are working.")
          .setContentIntent(pendingIntent)
          .setAutoCancel(true)
          .setCategory(NotificationCompat.CATEGORY_REMINDER)
          .build(),
      )
      null
    }
  } catch (error: Throwable) {
    error.message ?: error.javaClass.simpleName
  }

  fun ensureChannels(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java)
    val channels = listOf(
      NotificationChannel(CHANNEL_CALENDAR, "Calendar", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "Calendar reminders, tasks, birthdays, and invitations"
      },
      NotificationChannel(CHANNEL_COLLABORATION, "Collaboration", NotificationManager.IMPORTANCE_DEFAULT).apply {
        description = "Messages and mentions"
      },
      NotificationChannel(CHANNEL_SYNC, "Sync attention", NotificationManager.IMPORTANCE_DEFAULT).apply {
        description = "Sync failures and actions that need attention"
      },
      NotificationChannel(CHANNEL_TRANSFERS, "Transfers", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Completed uploads and downloads"
      },
    )
    manager.createNotificationChannels(channels)
  }

  fun refreshPushRegistration(context: Context) {
    if (FirebaseApp.getApps(context).isEmpty()) return
    FirebaseMessaging.getInstance().register()
  }

  @JvmStatic
  fun requestPushRegistration(context: Context): String? = try {
    refreshPushRegistration(context)
    null
  } catch (error: Throwable) {
    error.message ?: error.javaClass.simpleName
  }

  @JvmStatic
  fun existingPushInstallationId(context: Context): String? =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .getString("pushInstallationId", null)

  private fun installationId(context: Context): String {
    val preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val existing = preferences.getString("pushInstallationId", null)
    if (!existing.isNullOrBlank()) return existing
    return UUID.randomUUID().toString().also {
      preferences.edit().putString("pushInstallationId", it).apply()
    }
  }

  fun deliverDue(context: Context, profileId: String) {
    ensureChannels(context)
    if (permissionStatus(context) != "granted") {
      CollabNotificationScheduler.cancelProfile(context, profileId)
      return
    }
    val payloads = JSONArray(nativeListDue(context.applicationContext, profileId))
    for (index in 0 until payloads.length()) {
      val payload = payloads.getJSONObject(index)
      val notificationId = payload.getString("notificationId")
      val notificationIds = payload.optJSONArray("notificationIds") ?: JSONArray().put(notificationId)
      try {
        NotificationManagerCompat.from(context).notify(
          stableId(notificationId),
          buildNotification(context, payload),
        )
        for (deliveryIndex in 0 until notificationIds.length()) {
          nativeCompleteDelivery(
            context.applicationContext,
            profileId,
            notificationIds.getString(deliveryIndex),
            "",
          )
        }
      } catch (error: Throwable) {
        for (deliveryIndex in 0 until notificationIds.length()) {
          nativeCompleteDelivery(
            context.applicationContext,
            profileId,
            notificationIds.getString(deliveryIndex),
            (error.message ?: error.javaClass.simpleName).take(1000),
          )
        }
      }
    }
    CollabNotificationScheduler.reconcileProfile(context, profileId)
  }

  private fun buildNotification(context: Context, payload: JSONObject): android.app.Notification {
    val notificationId = payload.getString("notificationId")
    val profileId = payload.getString("profileId")
    val openIntent = Intent(context, MainActivity::class.java)
      .setAction(ACTION_OPEN)
      .putExtra(EXTRA_PROFILE_ID, profileId)
      .putExtra(EXTRA_NOTIFICATION_ID, notificationId)
      .setData(Uri.parse("collab://notification/open/${Uri.encode(notificationId)}"))
      .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    val contentIntent = PendingIntent.getActivity(
      context,
      stableId("open:$notificationId"),
      openIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val builder = NotificationCompat.Builder(context, channelId(payload.getString("channel")))
      .setSmallIcon(R.drawable.ic_notification)
      .setContentTitle(payload.getString("title"))
      .setContentIntent(contentIntent)
      .setAutoCancel(true)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setPriority(
        if (payload.optBoolean("timeSensitive", false)) {
          NotificationCompat.PRIORITY_HIGH
        } else {
          NotificationCompat.PRIORITY_DEFAULT
        },
      )
      .setCategory(category(payload.getString("kind")))
    payload.optString("body").takeIf { it.isNotBlank() }?.let(builder::setContentText)

    val actions = payload.optJSONArray("actions") ?: JSONArray()
    for (index in 0 until actions.length()) {
      val action = actions.getJSONObject(index)
      val kind = action.getString("kind")
      val token = action.getString("token")
      val actionIntent = Intent(context, CollabNotificationActionReceiver::class.java)
        .setAction(ACTION_APPLY)
        .putExtra(EXTRA_PROFILE_ID, profileId)
        .putExtra(EXTRA_NOTIFICATION_ID, notificationId)
        .putExtra(EXTRA_ACTION_TOKEN, token)
        .setData(Uri.parse("collab://notification/action/${Uri.encode(token)}"))
      val pending = PendingIntent.getBroadcast(
        context,
        stableId("action:$token"),
        actionIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      val label = when (kind) {
        "snooze" -> {
          val minutes = action.optLong("minutes", 10)
          "Snooze ${minutes}m"
        }
        else -> "Dismiss"
      }
      builder.addAction(0, label, pending)
      if (kind == "dismiss") builder.setDeleteIntent(pending)
    }
    return builder.build()
  }

  fun stableId(value: String): Int {
    val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
    return (
      ((digest[0].toInt() and 0xff) shl 24) or
      ((digest[1].toInt() and 0xff) shl 16) or
      ((digest[2].toInt() and 0xff) shl 8) or
      (digest[3].toInt() and 0xff)
    ) and Int.MAX_VALUE
  }

  private fun channelId(channel: String) = when (channel) {
    "collaboration" -> CHANNEL_COLLABORATION
    "sync" -> CHANNEL_SYNC
    "transfers" -> CHANNEL_TRANSFERS
    else -> CHANNEL_CALENDAR
  }

  private fun category(kind: String) = when {
    kind.startsWith("calendar.") -> NotificationCompat.CATEGORY_REMINDER
    kind.startsWith("collaboration.") -> NotificationCompat.CATEGORY_MESSAGE
    kind.startsWith("sync.") -> NotificationCompat.CATEGORY_ERROR
    else -> NotificationCompat.CATEGORY_STATUS
  }

  private const val CHANNEL_CALENDAR = "collab_calendar"
  private const val CHANNEL_COLLABORATION = "collab_collaboration"
  private const val CHANNEL_SYNC = "collab_sync"
  private const val CHANNEL_TRANSFERS = "collab_transfers"
}

class CollabFirebaseMessagingService : FirebaseMessagingService() {
  override fun onRegistered(installationId: String) {
    if (installationId.isBlank()) return
    CollabPushScheduler.register(
      applicationContext,
      localInstallationId(),
      installationId,
      BuildConfig.VERSION_NAME,
    )
  }

  override fun onMessageReceived(message: RemoteMessage) {
    val data = message.data
    val payload = JSONObject()
      .put("schemaVersion", data["schemaVersion"]?.toIntOrNull() ?: 0)
      .put("invalidationId", data["invalidationId"] ?: "")
      .put("accountKey", data["accountKey"] ?: "")
      .put("category", data["category"] ?: "")
      .put("createdAt", data["createdAt"] ?: "")
    data["cursor"]?.takeIf { it.isNotBlank() }?.let { payload.put("cursor", it) }
    CollabPushScheduler.catchUp(applicationContext, payload.toString())
  }

  private fun localInstallationId(): String {
    val preferences = getSharedPreferences(
      "collab-notification-permission",
      Context.MODE_PRIVATE,
    )
    val existing = preferences.getString("pushInstallationId", null)
    if (!existing.isNullOrBlank()) return existing
    return UUID.randomUUID().toString().also {
      preferences.edit().putString("pushInstallationId", it).apply()
    }
  }
}

object CollabNotificationScheduler {
  private const val ACTION_ALARM = "com.collab.companion.NOTIFICATION_ALARM"

  @JvmStatic
  fun exactAlarmStatus(context: Context): String {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return "granted"
    val alarmManager = context.getSystemService(AlarmManager::class.java)
    return if (alarmManager.canScheduleExactAlarms()) "granted" else "fallback"
  }

  @JvmStatic
  fun openExactAlarmSettings(context: Context): String? = try {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      context.startActivity(
        Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM)
          .setData(Uri.parse("package:${context.packageName}"))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      )
    }
    null
  } catch (error: Throwable) {
    error.message ?: error.javaClass.simpleName
  }

  @JvmStatic
  fun scheduleProfile(context: Context, profileId: String, scheduledAt: String): String? {
    return try {
      val alarmManager = context.getSystemService(AlarmManager::class.java)
      val pending = alarmIntent(context, profileId)
      if (scheduledAt.isBlank()) {
        alarmManager.cancel(pending)
      } else {
        val triggerAt = maxOf(System.currentTimeMillis() + 500, Instant.parse(scheduledAt).toEpochMilli())
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !alarmManager.canScheduleExactAlarms()) {
          alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pending)
        } else {
          alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pending)
        }
      }
      null
    } catch (error: Throwable) {
      error.message ?: error.javaClass.simpleName
    }
  }

  fun cancelProfile(context: Context, profileId: String) {
    context.getSystemService(AlarmManager::class.java).cancel(alarmIntent(context, profileId))
  }

  fun reconcileProfile(context: Context, profileId: String) {
    val schedules = JSONArray(
      CollabNotificationBridge.nativeProfileSchedules(context.applicationContext),
    )
    for (index in 0 until schedules.length()) {
      val schedule = schedules.getJSONObject(index)
      if (schedule.getString("profileId") != profileId) continue
      scheduleProfile(context, profileId, schedule.optString("scheduledAt"))
      return
    }
    cancelProfile(context, profileId)
  }

  fun reconcileAll(context: Context) {
    CollabNotificationBridge.ensureChannels(context)
    val schedules = JSONArray(
      CollabNotificationBridge.nativeProfileSchedules(context.applicationContext),
    )
    for (index in 0 until schedules.length()) {
      val schedule = schedules.getJSONObject(index)
      scheduleProfile(
        context,
        schedule.getString("profileId"),
        schedule.optString("scheduledAt"),
      )
    }
  }

  private fun alarmIntent(context: Context, profileId: String): PendingIntent {
    val intent = Intent(context, CollabNotificationAlarmReceiver::class.java)
      .setAction(ACTION_ALARM)
      .putExtra(CollabNotificationBridge.EXTRA_PROFILE_ID, profileId)
      .setData(Uri.parse("collab://notification/alarm/${Uri.encode(profileId)}"))
    return PendingIntent.getBroadcast(
      context,
      CollabNotificationBridge.stableId("alarm:$profileId"),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }
}

class CollabNotificationAlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val profileId = intent.getStringExtra(CollabNotificationBridge.EXTRA_PROFILE_ID) ?: return
    val pending = goAsync()
    EXECUTOR.execute {
      try {
        CollabNotificationBridge.deliverDue(context.applicationContext, profileId)
      } finally {
        pending.finish()
      }
    }
  }

  companion object {
    private val EXECUTOR = Executors.newSingleThreadExecutor()
  }
}

class CollabNotificationActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val profileId = intent.getStringExtra(CollabNotificationBridge.EXTRA_PROFILE_ID) ?: return
    val notificationId =
      intent.getStringExtra(CollabNotificationBridge.EXTRA_NOTIFICATION_ID) ?: return
    val token = intent.getStringExtra(CollabNotificationBridge.EXTRA_ACTION_TOKEN) ?: return
    val pending = goAsync()
    EXECUTOR.execute {
      try {
        CollabNotificationBridge.nativeApplyAction(context.applicationContext, profileId, token)
        NotificationManagerCompat.from(context).cancel(
          CollabNotificationBridge.stableId(notificationId),
        )
        CollabNotificationScheduler.reconcileProfile(context, profileId)
      } finally {
        pending.finish()
      }
    }
  }

  companion object {
    private val EXECUTOR = Executors.newSingleThreadExecutor()
  }
}

class CollabNotificationLifecycleReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val reason = intent.action ?: return
    val pending = goAsync()
    EXECUTOR.execute {
      try {
        CollabNotificationBridge.nativeRequestReconciliation(
          context.applicationContext,
          reason,
        )
        CollabNotificationScheduler.reconcileAll(context.applicationContext)
      } finally {
        pending.finish()
      }
    }
  }

  companion object {
    private val EXECUTOR = Executors.newSingleThreadExecutor()
  }
}
