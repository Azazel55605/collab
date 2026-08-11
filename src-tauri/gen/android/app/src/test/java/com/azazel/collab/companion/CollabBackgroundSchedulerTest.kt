package com.azazel.collab.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import androidx.work.NetworkType

class CollabBackgroundSchedulerTest {
  @Test
  fun intervalsRespectWorkManagerMinimumAndManualMode() {
    assertEquals(15L, CollabBackgroundScheduler.intervalMinutes("system_managed"))
    assertEquals(15L, CollabBackgroundScheduler.intervalMinutes("fifteen_minutes"))
    assertEquals(30L, CollabBackgroundScheduler.intervalMinutes("thirty_minutes"))
    assertEquals(60L, CollabBackgroundScheduler.intervalMinutes("hourly"))
    assertNull(CollabBackgroundScheduler.intervalMinutes("manual"))
  }

  @Test
  fun profileWorkNamesAreStableAndProfileScoped() {
    assertEquals(
      CollabBackgroundScheduler.profileWorkSuffix("profile-a"),
      CollabBackgroundScheduler.profileWorkSuffix("profile-a"),
    )
    assert(
      CollabBackgroundScheduler.profileWorkSuffix("profile-a") !=
        CollabBackgroundScheduler.profileWorkSuffix("profile-b"),
    )
    // "Aa" and "BB" collide under String.hashCode(), which must not merge
    // two distinct profiles into one unique WorkManager chain.
    assert(
      CollabBackgroundScheduler.profileWorkSuffix("Aa") !=
        CollabBackgroundScheduler.profileWorkSuffix("BB"),
    )
  }

  @Test
  fun networkPolicyPrefersUnmeteredThenNonRoaming() {
    assertEquals(
      NetworkType.UNMETERED,
      CollabBackgroundScheduler.requiredNetworkType(true, false),
    )
    assertEquals(
      NetworkType.NOT_ROAMING,
      CollabBackgroundScheduler.requiredNetworkType(false, false),
    )
    assertEquals(
      NetworkType.CONNECTED,
      CollabBackgroundScheduler.requiredNetworkType(false, true),
    )
  }

  @Test
  fun routineBackgroundWorkWaitsForStorageAndBatteryPolicy() {
    val constraints = CollabBackgroundScheduler.constraints(
      onlyUnmetered = false,
      requireCharging = true,
      pauseOnLowBattery = true,
      allowRoaming = true,
    )

    assertTrue(constraints.requiresCharging())
    assertTrue(constraints.requiresBatteryNotLow())
    assertTrue(constraints.requiresStorageNotLow())
  }

  @Test
  fun expeditedWorkCarriesOnlyTheConstraintsWorkManagerAccepts() {
    // WorkManager throws "Expedited jobs only support network and storage
    // constraints" out of enqueue when an expedited request carries a power
    // constraint, so a user-initiated sync must not ask for one. The network
    // constraint stays: it is about what the sync costs, not when it may run.
    val constraints = CollabBackgroundScheduler.constraints(
      onlyUnmetered = true,
      requireCharging = true,
      pauseOnLowBattery = true,
      allowRoaming = false,
      expedited = true,
    )

    assertFalse(constraints.requiresCharging())
    assertFalse(constraints.requiresBatteryNotLow())
    assertTrue(constraints.requiresStorageNotLow())
    assertEquals(NetworkType.UNMETERED, constraints.requiredNetworkType)
  }

  @Test
  fun workerErrorsAreBoundedAndSensitiveValuesAreRedacted() {
    assertEquals(
      "Native background work failed with a redacted sensitive response.",
      CollabBackgroundWorker.sanitizeWorkerError("request used Bearer secret"),
    )
    assertEquals(
      "network unavailable",
      CollabBackgroundWorker.sanitizeWorkerError("network unavailable"),
    )
  }
}

class CollabSyncProgressNotificationTest {
  @Test
  fun theProgressLineReportsCountsOnlyWhenTheRunStatedATotal() {
    assertEquals(
      "plan.md · 9 of 12",
      syncProgressText("plan.md", 9, 12),
    )
    // No total means no counts: "0 of 0" would read as a finished run.
    assertEquals("plan.md", syncProgressText("plan.md", 9, null))
    assertEquals("9 of 12", syncProgressText(null, 9, 12))
    // A run that has reported nothing still says something.
    assertEquals(
      "Checking for changes",
      syncProgressText(null, 0, null),
    )
  }
}
