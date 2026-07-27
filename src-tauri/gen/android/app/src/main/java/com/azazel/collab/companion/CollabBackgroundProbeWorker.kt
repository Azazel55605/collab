package com.azazel.collab.companion

import android.content.Context
import android.util.Log
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.WorkManager
import androidx.work.workDataOf
import java.util.concurrent.TimeUnit

class CollabBackgroundProbeWorker(
  appContext: Context,
  workerParams: WorkerParameters,
) : Worker(appContext, workerParams) {
  override fun doWork(): Result =
    try {
      val payload = CollabBackgroundProbe.runNativeProbe(
        applicationContext.filesDir.absolutePath,
        "android-workmanager",
      )
      Log.i(TAG, "Native background probe completed: $payload")
      Result.success(workDataOf(OUTPUT_PAYLOAD to payload))
    } catch (error: Throwable) {
      val message = error.message ?: error.javaClass.simpleName
      Log.e(TAG, "Native background probe failed", error)
      Result.failure(workDataOf(OUTPUT_ERROR to message.take(512)))
    }

  companion object {
    private const val TAG = "CollabBackgroundProbe"
    private const val UNIQUE_WORK_NAME = "collab-phase0-native-background-probe"
    private const val OUTPUT_PAYLOAD = "probePayload"
    private const val OUTPUT_ERROR = "probeError"

    fun schedule(context: Context) {
      val request = OneTimeWorkRequestBuilder<CollabBackgroundProbeWorker>()
        .setInitialDelay(10, TimeUnit.SECONDS)
        .addTag(UNIQUE_WORK_NAME)
        .build()
      WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(
        UNIQUE_WORK_NAME,
        ExistingWorkPolicy.KEEP,
        request,
      )
    }
  }
}
