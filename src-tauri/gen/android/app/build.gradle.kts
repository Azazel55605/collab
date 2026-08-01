import java.io.File
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Release signing is driven by a git-ignored `key.properties` in the gen/android
// root (see docs/mobile/android-play-release.md). When it is absent (dev machines / CI
// without secrets) the release build stays unsigned exactly as before, so nothing
// breaks; when present the release AAB/APK is signed with the upload key.
val keyProperties = Properties().apply {
    val propFile = rootProject.file("key.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}
val hasReleaseKey = keyProperties.getProperty("storeFile") != null
val keepNativeDebugSymbols = providers.gradleProperty("collabKeepNativeDebugSymbols")
    .map(String::toBoolean)
    .getOrElse(false)

android {
    compileSdk = 36
    namespace = "com.azazel.collab.companion"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        // Public Google Play identity (permanent once published). Intentionally
        // differs from `namespace` below: the internal code package stays
        // `com.azazel.collab.companion` (that is what Tauri/wry and our JNI class
        // lookups resolve against at compile time), while the app ships to users
        // and the Play Store as `com.collab.companion`. Android fully supports an
        // applicationId that differs from the code namespace.
        applicationId = "com.collab.companion"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        create("release") {
            if (hasReleaseKey) {
                storeFile = file(keyProperties.getProperty("storeFile"))
                storePassword = keyProperties.getProperty("storePassword")
                keyAlias = keyProperties.getProperty("keyAlias")
                keyPassword = keyProperties.getProperty("keyPassword")
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            if (keepNativeDebugSymbols) {
                packaging {
                    jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                    jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                    jniLibs.keepDebugSymbols.add("*/x86/*.so")
                    jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
                }
            }
        }
        getByName("release") {
            if (hasReleaseKey) {
                signingConfig = signingConfigs.getByName("release")
            }
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
        compose = true
    }
}

rust {
    rootDirRel = "../../../"
}

// AGP's strip task currently declines the Rust-built ELF and otherwise embeds
// hundreds of megabytes of DWARF in every debug APK. Strip only AGP's staged
// copy; the symbol-bearing library remains under target/ for native debugging.
tasks.matching {
    it.name.startsWith("strip") && it.name.endsWith("DebugDebugSymbols")
}.configureEach {
    doLast {
        if (keepNativeDebugSymbols) return@doLast
        val explicitNdkDirectory = sequenceOf(
            System.getenv("ANDROID_NDK_HOME"),
            System.getenv("NDK_HOME"),
        ).filterNotNull().map(::File).firstOrNull { it.isDirectory }
        val sdkDirectory = sequenceOf(
            System.getenv("ANDROID_SDK_ROOT"),
            System.getenv("ANDROID_HOME"),
        ).filterNotNull().map(::File).firstOrNull { it.isDirectory }
        val ndkDirectory = explicitNdkDirectory
            ?: sdkDirectory?.resolve("ndk")?.listFiles()?.filter { it.isDirectory }?.maxByOrNull { it.name }
            ?: error("Unable to locate an installed Android NDK for compact debug packaging")
        val stripTool = ndkDirectory
            .resolve("toolchains/llvm/prebuilt")
            .listFiles()
            .orEmpty()
            .flatMap { prebuilt ->
                listOf(prebuilt.resolve("bin/llvm-strip"), prebuilt.resolve("bin/llvm-strip.exe"))
            }
            .firstOrNull { it.isFile }
            ?: error("Unable to locate llvm-strip in Android NDK $ndkDirectory")
        outputs.files.asFileTree
            .matching { include("**/libcollab_lib.so") }
            .files
            .forEach { library ->
                project.exec { commandLine(stripTool, "--strip-unneeded", library) }
            }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.work:work-runtime:2.11.0")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.glance:glance-appwidget:1.1.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation(platform("com.google.firebase:firebase-bom:34.16.0"))
    implementation("com.google.firebase:firebase-messaging")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}

apply(from = "tauri.build.gradle.kts")
