package com.azazel.collab.companion

object CollabBackgroundProbe {
  init {
    System.loadLibrary("collab_lib")
  }

  @JvmStatic
  external fun runNativeProbe(filesDir: String, trigger: String): String
}
