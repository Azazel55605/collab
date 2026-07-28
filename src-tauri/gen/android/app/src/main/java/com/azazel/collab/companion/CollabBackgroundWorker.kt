package com.azazel.collab.companion

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class CollabBackgroundWorker(
  appContext: Context,
  workerParams: WorkerParameters,
) : Worker(appContext, workerParams) {
  override fun doWork(): Result {
    val trigger = inputData.getString(INPUT_TRIGGER) ?: return Result.failure()
    val profileId = inputData.getString(INPUT_PROFILE_ID) ?: return Result.failure()
    return try {
      val payload = CollabBackgroundBridge.runNativeWork(
        applicationContext,
        trigger,
        profileId,
      )
      val outcome = JSONObject(payload)
      val retryRecommended = outcome.optBoolean("retryRecommended", false)
      Log.i(TAG, "Native background work completed")
      if (retryRecommended && runAttemptCount < MAX_RETRY_ATTEMPTS) {
        Result.retry()
      } else {
        Result.success(
          workDataOf(
            OUTPUT_PAYLOAD to payload.take(MAX_OUTPUT_LENGTH),
            OUTPUT_ATTENTION_REQUIRED to outcome.optInt("attentionRequired", 0),
            OUTPUT_AUTH_REQUIRED to outcome.optBoolean("authenticationRequired", false),
            OUTPUT_PERMISSION_DENIED to outcome.optBoolean("permissionDenied", false),
          ),
        )
      }
    } catch (error: Throwable) {
      val message = sanitizeWorkerError(error.message ?: error.javaClass.simpleName)
      Log.e(TAG, "Native background work failed: $message")
      if (runAttemptCount < MAX_RETRY_ATTEMPTS) {
        Result.retry()
      } else {
        Result.failure(workDataOf(OUTPUT_ERROR to message.take(MAX_OUTPUT_LENGTH)))
      }
    }
  }

  companion object {
    private const val TAG = "CollabBackground"
    private const val MAX_RETRY_ATTEMPTS = 5
    private const val MAX_OUTPUT_LENGTH = 4096
    const val INPUT_TRIGGER = "trigger"
    const val INPUT_PROFILE_ID = "profileId"
    const val OUTPUT_PAYLOAD = "backgroundPayload"
    const val OUTPUT_ERROR = "backgroundError"
    const val OUTPUT_ATTENTION_REQUIRED = "attentionRequired"
    const val OUTPUT_AUTH_REQUIRED = "authenticationRequired"
    const val OUTPUT_PERMISSION_DENIED = "permissionDenied"

    internal fun sanitizeWorkerError(message: String): String {
      val lower = message.lowercase()
      if (
        lower.contains("bearer ") ||
        lower.contains("accesstoken") ||
        lower.contains("refreshtoken") ||
        lower.contains("password")
      ) {
        return "Native background work failed with a redacted sensitive response."
      }
      return message.take(MAX_OUTPUT_LENGTH)
    }
  }
}

object CollabBackgroundScheduler {
  private const val PERIODIC_PREFIX = "collab-background-periodic-"
  private const val CATCH_UP_PREFIX = "collab-background-catch-up-"
  private const val USER_PREFIX = "collab-background-user-"

  internal fun intervalMinutes(interval: String): Long? = when (interval) {
    "system_managed", "fifteen_minutes" -> 15
    "thirty_minutes" -> 30
    "hourly" -> 60
    "manual" -> null
    else -> null
  }

  internal fun profileWorkSuffix(profileId: String): String =
    profileId.toByteArray(Charsets.UTF_8).joinToString("") { byte ->
      byte.toUByte().toString(16).padStart(2, '0')
    }

  internal fun requiredNetworkType(
    onlyUnmetered: Boolean,
    allowRoaming: Boolean,
  ): NetworkType = when {
    onlyUnmetered -> NetworkType.UNMETERED
    !allowRoaming -> NetworkType.NOT_ROAMING
    else -> NetworkType.CONNECTED
  }

  internal fun constraints(
    onlyUnmetered: Boolean,
    requireCharging: Boolean,
    pauseOnLowBattery: Boolean,
    allowRoaming: Boolean,
  ): Constraints =
    Constraints.Builder()
      .setRequiredNetworkType(requiredNetworkType(onlyUnmetered, allowRoaming))
      .setRequiresCharging(requireCharging)
      .setRequiresBatteryNotLow(pauseOnLowBattery)
      .setRequiresStorageNotLow(true)
      .build()

  private fun periodicName(profileId: String) = PERIODIC_PREFIX + profileWorkSuffix(profileId)
  private fun catchUpName(profileId: String) = CATCH_UP_PREFIX + profileWorkSuffix(profileId)
  private fun userName(profileId: String) = USER_PREFIX + profileWorkSuffix(profileId)

  @JvmStatic
  fun configure(
    context: Context,
    profileId: String,
    enabled: String,
    interval: String,
    onlyUnmetered: String,
    requireCharging: String,
    pauseOnLowBattery: String,
    allowRoaming: String,
  ): String? = try {
    val workManager = WorkManager.getInstance(context.applicationContext)
    val minutes = intervalMinutes(interval)
    if (enabled != "true" || minutes == null) {
      workManager.cancelUniqueWork(periodicName(profileId))
      null
    } else {
      val request = PeriodicWorkRequestBuilder<CollabBackgroundWorker>(
        minutes,
        TimeUnit.MINUTES,
        minOf(5, minutes),
        TimeUnit.MINUTES,
      )
        .setConstraints(
          constraints(
            onlyUnmetered == "true",
            requireCharging == "true",
            pauseOnLowBattery == "true",
            allowRoaming == "true",
          ),
        )
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
        .setInputData(
          workDataOf(
            CollabBackgroundWorker.INPUT_TRIGGER to "periodic",
            CollabBackgroundWorker.INPUT_PROFILE_ID to profileId,
          ),
        )
        .addTag(periodicName(profileId))
        .build()
      workManager.enqueueUniquePeriodicWork(
        periodicName(profileId),
        ExistingPeriodicWorkPolicy.UPDATE,
        request,
      )
      null
    }
  } catch (error: Throwable) {
    error.message ?: error.javaClass.simpleName
  }

  @JvmStatic
  fun requestImmediate(
    context: Context,
    profileId: String,
    userInitiated: String,
    onlyUnmetered: String,
    requireCharging: String,
    pauseOnLowBattery: String,
    allowRoaming: String,
  ): String? = try {
    val isUserInitiated = userInitiated == "true"
    val requestBuilder = OneTimeWorkRequestBuilder<CollabBackgroundWorker>()
      .setConstraints(
        constraints(
          onlyUnmetered == "true",
          requireCharging == "true",
          pauseOnLowBattery == "true",
          allowRoaming == "true",
        ),
      )
      .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
      .setInputData(
        workDataOf(
          CollabBackgroundWorker.INPUT_TRIGGER to if (isUserInitiated) {
            "user-initiated"
          } else {
            "catch-up"
          },
          CollabBackgroundWorker.INPUT_PROFILE_ID to profileId,
        ),
      )
    if (isUserInitiated) {
      requestBuilder.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
    }
    val name = if (isUserInitiated) userName(profileId) else catchUpName(profileId)
    WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(
      name,
      ExistingWorkPolicy.KEEP,
      requestBuilder.addTag(name).build(),
    )
    null
  } catch (error: Throwable) {
    error.message ?: error.javaClass.simpleName
  }

  @JvmStatic
  fun cancelProfile(context: Context, profileId: String): String? = try {
    val workManager = WorkManager.getInstance(context.applicationContext)
    workManager.cancelUniqueWork(periodicName(profileId))
    workManager.cancelUniqueWork(catchUpName(profileId))
    workManager.cancelUniqueWork(userName(profileId))
    null
  } catch (error: Throwable) {
    error.message ?: error.javaClass.simpleName
  }
}
