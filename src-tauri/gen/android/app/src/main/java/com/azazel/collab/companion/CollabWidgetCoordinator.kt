package com.azazel.collab.companion

import android.content.Context
import android.content.Intent
import androidx.work.BackoffPolicy
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import java.time.Duration
import java.time.Instant
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

private const val WIDGET_STALE_AFTER_MINUTES = 30L

internal fun widgetSnapshotIsStale(
  generatedAt: String?,
  now: Instant = Instant.now(),
): Boolean {
  val generated = generatedAt?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: return true
  return generated.isAfter(now.plus(Duration.ofMinutes(5))) ||
    Duration.between(generated, now) >= Duration.ofMinutes(WIDGET_STALE_AFTER_MINUTES)
}

class CollabWidgetRefreshWorker(
  appContext: Context,
  workerParams: WorkerParameters,
) : Worker(appContext, workerParams) {
  override fun doWork(): Result {
    val profileId = inputData.getString(INPUT_PROFILE_ID) ?: return Result.failure()
    val cause = inputData.getString(INPUT_CAUSE) ?: "fallback"
    return runCatching {
      CollabWidgetBridge.rebuildProfile(applicationContext, profileId, cause)
      Result.success()
    }.getOrElse {
      if (runAttemptCount < 3) Result.retry() else Result.failure()
    }
  }

  companion object {
    const val INPUT_PROFILE_ID = "profileId"
    const val INPUT_CAUSE = "cause"
  }
}

internal object CollabWidgetRefreshScheduler {
  private const val PERIODIC_PREFIX = "collab-widget-periodic-"
  private const val REFRESH_PREFIX = "collab-widget-refresh-"
  private const val PREFERENCES = "collab-widget-refresh-scheduler"
  private const val SCHEDULED_PROFILES = "scheduledProfiles"

  private fun suffix(profileId: String): String =
    profileId.toByteArray(Charsets.UTF_8).joinToString("") { byte ->
      byte.toUByte().toString(16).padStart(2, '0')
    }

  private fun periodicName(profileId: String) = PERIODIC_PREFIX + suffix(profileId)
  private fun refreshName(profileId: String) = REFRESH_PREFIX + suffix(profileId)

  fun reconcile(context: Context) {
    val appContext = context.applicationContext
    val activeProfiles = CollabWidgetBindings.active(appContext).values
      .map { it.profileId }
      .toSet()
    val preferences = appContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    val scheduledProfiles = preferences.getStringSet(SCHEDULED_PROFILES, emptySet()).orEmpty()
    (scheduledProfiles - activeProfiles).forEach { cancelProfile(appContext, it) }
    activeProfiles.forEach { schedulePeriodic(appContext, it) }
    preferences.edit().putStringSet(SCHEDULED_PROFILES, activeProfiles).apply()
  }

  fun request(context: Context, profileId: String, cause: String) {
    val request = OneTimeWorkRequestBuilder<CollabWidgetRefreshWorker>()
      .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
      .setInputData(
        workDataOf(
          CollabWidgetRefreshWorker.INPUT_PROFILE_ID to profileId,
          CollabWidgetRefreshWorker.INPUT_CAUSE to cause,
        ),
      )
      .build()
    WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(
      refreshName(profileId),
      ExistingWorkPolicy.KEEP,
      request,
    )
  }

  private fun schedulePeriodic(context: Context, profileId: String) {
    val request = PeriodicWorkRequestBuilder<CollabWidgetRefreshWorker>(
      WIDGET_STALE_AFTER_MINUTES,
      TimeUnit.MINUTES,
      10,
      TimeUnit.MINUTES,
    )
      .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
      .setInputData(
        workDataOf(
          CollabWidgetRefreshWorker.INPUT_PROFILE_ID to profileId,
          CollabWidgetRefreshWorker.INPUT_CAUSE to "periodic-fallback",
        ),
      )
      .build()
    WorkManager.getInstance(context.applicationContext).enqueueUniquePeriodicWork(
      periodicName(profileId),
      ExistingPeriodicWorkPolicy.UPDATE,
      request,
    )
  }

  fun cancelProfile(context: Context, profileId: String) {
    val workManager = WorkManager.getInstance(context.applicationContext)
    workManager.cancelUniqueWork(periodicName(profileId))
    workManager.cancelUniqueWork(refreshName(profileId))
  }
}

internal object CollabWidgetUpdateCoordinator {
  private val executor = Executors.newSingleThreadExecutor()

  fun onUpdate(context: Context, appWidgetIds: IntArray, completed: () -> Unit = {}) {
    val appContext = context.applicationContext
    executor.execute {
      try {
        // This path is already handling ACTION_APPWIDGET_UPDATE. Re-broadcasting
        // from here would recursively invoke the provider until the process dies.
        CollabWidgetBridge.requestAgendaUpdate(appContext, AgendaWidgetUpdateOrigin.Provider)
        val bindings = appWidgetIds.asIterable().mapNotNull {
          CollabWidgetBindings.read(appContext, it)
        }
        bindings.groupBy { it.profileId }.forEach { (profileId, profileBindings) ->
          val stale = profileBindings.any { binding ->
            val raw = CollabWidgetBridge.readBoundSnapshotRaw(appContext, binding)
            val snapshot = raw?.let { runCatching { CollabAgendaWidgetSnapshotStore.parse(it) }.getOrNull() }
            snapshot == null || widgetSnapshotIsStale(snapshot.generatedAt)
          }
          if (stale) CollabWidgetRefreshScheduler.request(appContext, profileId, "launcher-update")
        }
        CollabWidgetRefreshScheduler.reconcile(appContext)
      } finally {
        completed()
      }
    }
  }

  fun onLifecycle(context: Context, intent: Intent, completed: () -> Unit = {}) {
    val appContext = context.applicationContext
    executor.execute {
      try {
        CollabWidgetBridge.requestAgendaUpdate(appContext)
        val cause = when (intent.action) {
          Intent.ACTION_BOOT_COMPLETED -> "boot"
          Intent.ACTION_MY_PACKAGE_REPLACED -> "app-replaced"
          Intent.ACTION_TIME_CHANGED -> "time-change"
          Intent.ACTION_TIMEZONE_CHANGED -> "timezone-change"
          Intent.ACTION_LOCALE_CHANGED -> "locale-change"
          Intent.ACTION_USER_UNLOCKED -> "user-unlock"
          else -> "lifecycle"
        }
        CollabWidgetBindings.active(appContext).values
          .map { it.profileId }
          .distinct()
          .forEach { CollabWidgetRefreshScheduler.request(appContext, it, cause) }
        CollabWidgetRefreshScheduler.reconcile(appContext)
      } finally {
        completed()
      }
    }
  }

  fun onForeground(context: Context) {
    val appContext = context.applicationContext
    executor.execute {
      CollabWidgetRefreshScheduler.reconcile(appContext)
      CollabWidgetBridge.requestPhase0Rebuild(appContext)
    }
  }
}
