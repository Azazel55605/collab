package com.azazel.collab.companion

import android.content.Context

object CollabBackgroundBridge {
  init {
    System.loadLibrary("collab_lib")
  }

  @JvmStatic
  external fun runNativeWork(
    context: Context,
    trigger: String,
    profileId: String,
  ): String
}
