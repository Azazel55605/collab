//! Small shared JNI helpers for calling the companion app's Kotlin secret-store
//! classes from Rust on Android. Both the refresh-token store
//! (`server_token_store`) and the offline-replica key store (`commands/replica`)
//! call static Kotlin methods that take the app `Context` plus one or more
//! `String` arguments and return a nullable `String`, so that pattern is shared
//! here instead of forked per store.

#![cfg(target_os = "android")]

use jni::objects::{GlobalRef, JClass, JObject, JString, JValue};
use jni::sys::{jboolean, jstring, JNI_FALSE, JNI_TRUE};
use jni::{JNIEnv, JavaVM};
use std::mem::ManuallyDrop;
use std::path::PathBuf;
use std::sync::OnceLock;

struct AndroidWorkerContext {
    java_vm: JavaVM,
    context: GlobalRef,
}

static WORKER_CONTEXT: OnceLock<AndroidWorkerContext> = OnceLock::new();

pub(crate) fn register_worker_context(
    env: &mut JNIEnv<'_>,
    context: &JObject<'_>,
) -> Result<(), String> {
    if WORKER_CONTEXT.get().is_some() {
        return Ok(());
    }
    let java_vm = env
        .get_java_vm()
        .map_err(|_| "Could not access the Android Java VM.".to_string())?;
    let context = env
        .new_global_ref(context)
        .map_err(|_| "Could not retain the Android application context.".to_string())?;
    let _ = WORKER_CONTEXT.set(AndroidWorkerContext { java_vm, context });
    Ok(())
}

/// Runs `callback` with an attached JNI environment and the app `Context`.
fn with_env<T>(
    callback: impl for<'local> FnOnce(&mut JNIEnv<'local>, &JObject<'local>) -> Result<T, String>,
) -> Result<T, String> {
    if let Some(runtime) = WORKER_CONTEXT.get() {
        let mut env = runtime
            .java_vm
            .attach_current_thread()
            .map_err(|_| "Could not attach to the Android Java VM.".to_string())?;
        return callback(&mut env, runtime.context.as_obj());
    }
    let context = ndk_context::android_context();
    let java_vm = unsafe { JavaVM::from_raw(context.vm().cast()) }
        .map_err(|_| "Could not access the Android Java VM.".to_string())?;
    let java_vm = ManuallyDrop::new(java_vm);
    let mut env = java_vm
        .attach_current_thread()
        .map_err(|_| "Could not attach to the Android Java VM.".to_string())?;
    // `ndk_context` owns this global context reference. Borrow it for the JNI
    // call, but do not let `JObject` drop and delete a reference we did not create.
    let context = ManuallyDrop::new(unsafe { JObject::from_raw(context.context().cast()) });
    callback(&mut env, &context)
}

pub fn files_dir() -> Result<PathBuf, String> {
    with_env(|env, context| {
        let files_dir = env
            .call_method(context, "getFilesDir", "()Ljava/io/File;", &[])
            .map_err(|_| {
                clear_exception(env);
                "Could not access the Android app files directory.".to_string()
            })?
            .l()
            .map_err(|_| "Android returned an invalid app files directory.".to_string())?;
        let path = env
            .call_method(&files_dir, "getAbsolutePath", "()Ljava/lang/String;", &[])
            .map_err(|_| {
                clear_exception(env);
                "Could not read the Android app files directory path.".to_string()
            })?
            .l()
            .map_err(|_| "Android returned an invalid app files directory path.".to_string())?;
        read_string(env, path)
            .map(PathBuf::from)
            .ok_or_else(|| "Android returned an empty app files directory.".to_string())
    })
}

pub(crate) fn request_widget_profile_rebuild(profile_id: &str) -> Result<(), String> {
    with_env(|env, context| {
        let class = load_class(
            env,
            context,
            "com.azazel.collab.companion.CollabWidgetBridge",
        )?;
        let profile_id = java_string(env, profile_id)?;
        env.call_static_method(
            class,
            "requestProfileRebuild",
            "(Landroid/content/Context;Ljava/lang/String;)V",
            &[JValue::Object(context), JValue::Object(&profile_id)],
        )
        .map_err(|_| {
            clear_exception(env);
            "Could not request an Android widget refresh.".to_string()
        })?;
        Ok(())
    })
}

pub(crate) fn bound_widget_configuration_ids(profile_id: &str) -> Result<Vec<String>, String> {
    with_env(|env, context| {
        let class = load_class(
            env,
            context,
            "com.azazel.collab.companion.CollabWidgetBridge",
        )?;
        let profile_id = java_string(env, profile_id)?;
        let result = env
            .call_static_method(
                class,
                "boundConfigurationIds",
                "(Landroid/content/Context;Ljava/lang/String;)Ljava/lang/String;",
                &[JValue::Object(context), JValue::Object(&profile_id)],
            )
            .map_err(|_| {
                clear_exception(env);
                "Could not read the Android widget bindings.".to_string()
            })?
            .l()
            .map_err(|_| "Android returned invalid widget bindings.".to_string())?;
        let raw = read_string(env, result)
            .ok_or_else(|| "Android returned empty widget bindings.".to_string())?;
        serde_json::from_str(&raw)
            .map_err(|_| "Android returned malformed widget bindings.".to_string())
    })
}

pub(crate) fn update_widgets() -> Result<(), String> {
    with_env(|env, context| {
        let class = load_class(
            env,
            context,
            "com.azazel.collab.companion.CollabWidgetBridge",
        )?;
        env.call_static_method(
            class,
            "updateWidgets",
            "(Landroid/content/Context;)V",
            &[JValue::Object(context)],
        )
        .map_err(|_| {
            clear_exception(env);
            "Could not update the Android widgets.".to_string()
        })?;
        Ok(())
    })
}

pub(crate) fn cancel_widget_profile(profile_id: &str) -> Result<(), String> {
    with_env(|env, context| {
        let class = load_class(
            env,
            context,
            "com.azazel.collab.companion.CollabWidgetBridge",
        )?;
        let profile_id = java_string(env, profile_id)?;
        env.call_static_method(
            class,
            "cancelProfile",
            "(Landroid/content/Context;Ljava/lang/String;)V",
            &[JValue::Object(context), JValue::Object(&profile_id)],
        )
        .map_err(|_| {
            clear_exception(env);
            "Could not cancel Android widget work.".to_string()
        })?;
        Ok(())
    })
}

fn clear_exception(env: &mut JNIEnv<'_>) {
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
    }
}

fn java_string<'local>(env: &mut JNIEnv<'local>, value: &str) -> Result<JObject<'local>, String> {
    env.new_string(value)
        .map(JObject::from)
        .map_err(|_| "Could not create an Android string.".to_string())
}

/// Loads a class by dotted name through the app context's class loader (the
/// system class loader cannot see the app's own classes from a native thread).
fn load_class<'local>(
    env: &mut JNIEnv<'local>,
    context: &JObject<'local>,
    dotted_name: &str,
) -> Result<JClass<'local>, String> {
    let loader = env
        .call_method(context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
        .map_err(|_| {
            clear_exception(env);
            "Could not access the Android class loader.".to_string()
        })?
        .l()
        .map_err(|_| "Android returned an invalid class loader.".to_string())?;
    let class_name = java_string(env, dotted_name)?;
    let class = env
        .call_method(
            &loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[JValue::Object(&class_name)],
        )
        .map_err(|_| {
            clear_exception(env);
            "Could not load an Android helper class.".to_string()
        })?
        .l()
        .map_err(|_| "Android returned an invalid helper class.".to_string())?;
    Ok(JClass::from(class))
}

fn read_string(env: &mut JNIEnv<'_>, value: JObject<'_>) -> Option<String> {
    if value.is_null() {
        return None;
    }
    let value = JString::from(value);
    env.get_string(&value)
        .ok()
        .map(|value| value.to_string_lossy().into_owned())
}

/// Calls a static Kotlin method `class_name.method(Context, arg0, arg1, …)` where
/// every extra argument and the return value is a nullable `String`. Returns the
/// method's return value (`None` for a Java `null`). A JNI failure is surfaced as
/// `Err`; a thrown Java exception is cleared and reported.
pub fn call_static_string(
    class_name: &str,
    method: &str,
    args: &[&str],
) -> Result<Option<String>, String> {
    with_env(|env, context| {
        let class = load_class(env, context, class_name)?;
        // Build the JVM signature: (Landroid/content/Context;Ljava/lang/String;…)Ljava/lang/String;
        let mut signature = String::from("(Landroid/content/Context;");
        for _ in args {
            signature.push_str("Ljava/lang/String;");
        }
        signature.push_str(")Ljava/lang/String;");

        // Materialize the Java string arguments, then borrow them as JValues.
        let java_args = args
            .iter()
            .map(|value| java_string(env, value))
            .collect::<Result<Vec<_>, _>>()?;
        let mut values: Vec<JValue> = Vec::with_capacity(java_args.len() + 1);
        values.push(JValue::Object(context));
        for arg in &java_args {
            values.push(JValue::Object(arg));
        }

        let result = env
            .call_static_method(class, method, &signature, &values)
            .map_err(|_| {
                clear_exception(env);
                "The Android helper call failed.".to_string()
            })?
            .l()
            .map_err(|_| {
                clear_exception(env);
                "The Android helper returned an invalid result.".to_string()
            })?;
        Ok(read_string(env, result))
    })
}

const BACKGROUND_SCHEDULER_CLASS: &str = "com.azazel.collab.companion.CollabBackgroundScheduler";
const NOTIFICATION_BRIDGE_CLASS: &str = "com.azazel.collab.companion.CollabNotificationBridge";
const NOTIFICATION_SCHEDULER_CLASS: &str =
    "com.azazel.collab.companion.CollabNotificationScheduler";
const APP_DESTINATION_CLASS: &str = "com.azazel.collab.companion.CollabAppDestination";

pub fn take_pending_app_destination() -> Result<Option<String>, String> {
    call_static_string(APP_DESTINATION_CLASS, "takePendingJson", &[])
}

pub fn notification_permission_status() -> Result<String, String> {
    call_static_string(NOTIFICATION_BRIDGE_CLASS, "permissionStatus", &[])?
        .ok_or_else(|| "Android returned no notification permission state.".to_string())
}

pub fn request_notification_permission() -> Result<String, String> {
    let status = call_static_string(NOTIFICATION_BRIDGE_CLASS, "requestPermission", &[])?
        .ok_or_else(|| "Android returned no notification permission state.".to_string())?;
    if status == "activity-unavailable" {
        return Err(
            "Bring Collab to the foreground before requesting notification permission.".to_string(),
        );
    }
    Ok(status)
}

pub fn send_test_notification() -> Result<(), String> {
    match call_static_string(NOTIFICATION_BRIDGE_CLASS, "sendTest", &[])? {
        Some(error) => Err(format!(
            "Could not show the Android test notification: {error}"
        )),
        None => Ok(()),
    }
}

pub fn take_pending_notification_open() -> Result<Option<String>, String> {
    call_static_string(NOTIFICATION_BRIDGE_CLASS, "takePendingOpen", &[])
}

pub fn exact_alarm_status() -> Result<String, String> {
    call_static_string(NOTIFICATION_SCHEDULER_CLASS, "exactAlarmStatus", &[])?
        .ok_or_else(|| "Android returned no exact-alarm status.".to_string())
}

pub fn open_exact_alarm_settings() -> Result<(), String> {
    match call_static_string(NOTIFICATION_SCHEDULER_CLASS, "openExactAlarmSettings", &[])? {
        Some(error) => Err(format!("Could not open Android alarm settings: {error}")),
        None => Ok(()),
    }
}

pub fn schedule_notification_profile(
    profile_id: &str,
    scheduled_at: Option<&str>,
) -> Result<(), String> {
    match call_static_string(
        NOTIFICATION_SCHEDULER_CLASS,
        "scheduleProfile",
        &[profile_id, scheduled_at.unwrap_or("")],
    )? {
        Some(error) => Err(format!("Could not schedule Android notifications: {error}")),
        None => Ok(()),
    }
}

pub fn refresh_push_registration() -> Result<(), String> {
    match call_static_string(NOTIFICATION_BRIDGE_CLASS, "requestPushRegistration", &[])? {
        Some(error) => Err(format!(
            "Could not refresh Android push registration: {error}"
        )),
        None => Ok(()),
    }
}

pub fn push_installation_id() -> Result<Option<String>, String> {
    call_static_string(NOTIFICATION_BRIDGE_CLASS, "existingPushInstallationId", &[])
}

pub fn configure_background_scheduler(
    profile_id: &str,
    enabled: bool,
    interval: &str,
    only_unmetered_networks: bool,
    require_charging: bool,
    pause_on_low_battery: bool,
    allow_roaming: bool,
) -> Result<(), String> {
    match call_static_string(
        BACKGROUND_SCHEDULER_CLASS,
        "configure",
        &[
            profile_id,
            if enabled { "true" } else { "false" },
            interval,
            if only_unmetered_networks {
                "true"
            } else {
                "false"
            },
            if require_charging { "true" } else { "false" },
            if pause_on_low_battery {
                "true"
            } else {
                "false"
            },
            if allow_roaming { "true" } else { "false" },
        ],
    )? {
        Some(error) => Err(format!(
            "Could not configure Android background work: {error}"
        )),
        None => Ok(()),
    }
}

pub fn request_immediate_background_work(
    profile_id: &str,
    user_initiated: bool,
    only_unmetered_networks: bool,
    require_charging: bool,
    pause_on_low_battery: bool,
    allow_roaming: bool,
) -> Result<(), String> {
    match call_static_string(
        BACKGROUND_SCHEDULER_CLASS,
        "requestImmediate",
        &[
            profile_id,
            if user_initiated { "true" } else { "false" },
            if only_unmetered_networks {
                "true"
            } else {
                "false"
            },
            if require_charging { "true" } else { "false" },
            if pause_on_low_battery {
                "true"
            } else {
                "false"
            },
            if allow_roaming { "true" } else { "false" },
        ],
    )? {
        Some(error) => Err(format!(
            "Could not request Android background work: {error}"
        )),
        None => Ok(()),
    }
}

pub fn request_background_diagnostic(profile_id: &str) -> Result<(), String> {
    match call_static_string(
        BACKGROUND_SCHEDULER_CLASS,
        "requestDiagnostic",
        &[profile_id],
    )? {
        Some(error) => Err(format!(
            "Could not schedule the background sync check: {error}"
        )),
        None => Ok(()),
    }
}

pub fn cancel_background_profile(profile_id: &str) -> Result<(), String> {
    match call_static_string(BACKGROUND_SCHEDULER_CLASS, "cancelProfile", &[profile_id])? {
        Some(error) => Err(format!("Could not cancel Android background work: {error}")),
        None => Ok(()),
    }
}

#[no_mangle]
pub extern "system" fn Java_com_azazel_collab_companion_CollabBackgroundProbe_runNativeProbe(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    files_dir: JString<'_>,
    trigger: JString<'_>,
) -> jstring {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let files_dir = env
            .get_string(&files_dir)
            .map_err(|_| "Could not decode the Android files directory.".to_string())?
            .to_string_lossy()
            .into_owned();
        let trigger = env
            .get_string(&trigger)
            .map_err(|_| "Could not decode the background probe trigger.".to_string())?
            .to_string_lossy()
            .into_owned();
        let root = std::path::PathBuf::from(files_dir).join("collab");
        let probe = crate::commands::background::run_background_runtime_probe(&root, &trigger)?;
        serde_json::to_string(&probe)
            .map_err(|error| format!("Could not encode the background probe result: {error}"))
    }));

    match result {
        Ok(Ok(payload)) => env
            .new_string(payload)
            .map(JString::into_raw)
            .unwrap_or(std::ptr::null_mut()),
        Ok(Err(error)) => {
            let _ = env.throw_new("java/lang/IllegalStateException", error);
            std::ptr::null_mut()
        }
        Err(_) => {
            let _ = env.throw_new(
                "java/lang/IllegalStateException",
                "The native background probe panicked.",
            );
            std::ptr::null_mut()
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_com_azazel_collab_companion_CollabBackgroundBridge_runNativeWork(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    context: JObject<'_>,
    trigger: JString<'_>,
    profile_id: JString<'_>,
) -> jstring {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        register_worker_context(&mut env, &context)?;
        let trigger = env
            .get_string(&trigger)
            .map_err(|_| "Could not decode the Android background trigger.".to_string())?
            .to_string_lossy()
            .into_owned();
        let trigger = match trigger.as_str() {
            "periodic" => crate::background::BackgroundJobTrigger::Periodic,
            "catch-up" | "user-initiated" | "diagnostic" => {
                crate::background::BackgroundJobTrigger::UserInitiated
            }
            _ => return Err("The Android background trigger is invalid.".to_string()),
        };
        let profile_id = env
            .get_string(&profile_id)
            .map_err(|_| "Could not decode the Android profile ID.".to_string())?
            .to_string_lossy()
            .into_owned();
        if profile_id.trim().is_empty() || profile_id.len() > 128 {
            return Err("The Android background profile ID is invalid.".to_string());
        }

        let coordinator = crate::state::app_state::shared_background_coordinator();
        let outcome = tauri::async_runtime::block_on(coordinator.run_registered_to_completion(
            trigger,
            Some(&profile_id),
            std::time::Duration::from_secs(9 * 60),
        ))?;
        serde_json::to_string(&outcome)
            .map_err(|error| format!("Could not encode the background result: {error}"))
    }));

    match result {
        Ok(Ok(payload)) => env
            .new_string(payload)
            .map(JString::into_raw)
            .unwrap_or(std::ptr::null_mut()),
        Ok(Err(error)) => {
            let _ = env.throw_new("java/lang/IllegalStateException", error);
            std::ptr::null_mut()
        }
        Err(_) => {
            let _ = env.throw_new(
                "java/lang/IllegalStateException",
                "The native Android background worker panicked.",
            );
            std::ptr::null_mut()
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_com_azazel_collab_companion_CollabWidgetBridge_nativeBuildAgendaPreview(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    context: JObject<'_>,
    date_label: JString<'_>,
) -> jstring {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        register_worker_context(&mut env, &context)?;
        let date_label = env
            .get_string(&date_label)
            .map_err(|_| "Could not decode the agenda widget date label.".to_string())?
            .to_string_lossy()
            .into_owned();
        crate::widgets::build_phase0_agenda_preview(&date_label)
    }));

    match result {
        Ok(Ok(payload)) => env
            .new_string(payload)
            .map(JString::into_raw)
            .unwrap_or(std::ptr::null_mut()),
        Ok(Err(error)) => {
            let _ = env.throw_new("java/lang/IllegalArgumentException", error);
            std::ptr::null_mut()
        }
        Err(_) => {
            let _ = env.throw_new(
                "java/lang/IllegalStateException",
                "The native agenda widget preview builder panicked.",
            );
            std::ptr::null_mut()
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_com_azazel_collab_companion_CollabWidgetBridge_nativeActiveProfile(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    context: JObject<'_>,
) -> jstring {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        register_worker_context(&mut env, &context)?;
        let root = files_dir()?.join("collab");
        crate::widgets::active_profile(&root)
    }));
    match result {
        Ok(Ok(Some(profile_id))) => env
            .new_string(profile_id)
            .map(JString::into_raw)
            .unwrap_or(std::ptr::null_mut()),
        Ok(Ok(None)) => std::ptr::null_mut(),
        Ok(Err(error)) => {
            let _ = env.throw_new("java/lang/IllegalStateException", error);
            std::ptr::null_mut()
        }
        Err(_) => {
            let _ = env.throw_new(
                "java/lang/IllegalStateException",
                "The native widget profile lookup failed.",
            );
            std::ptr::null_mut()
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_com_azazel_collab_companion_CollabWidgetBridge_nativeReadAppearance(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    context: JObject<'_>,
) -> jstring {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        register_worker_context(&mut env, &context)?;
        let root = files_dir()?.join("collab");
        let appearance = crate::widgets::read_appearance(&root)?;
        serde_json::to_string(&appearance)
            .map_err(|_| "Could not encode the widget appearance settings.".to_string())
    }));
    widget_jni_string_result(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_com_azazel_collab_companion_CollabWidgetBridge_nativeListConfigurations(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    context: JObject<'_>,
    profile_id: JString<'_>,
) -> jstring {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        register_worker_context(&mut env, &context)?;
        let profile_id = env
            .get_string(&profile_id)
            .map_err(|_| "Could not decode the widget profile identifier.".to_string())?
            .to_string_lossy()
            .into_owned();
        let root = files_dir()?.join("collab");
        let configurations =
            crate::widgets::WidgetStore::open(&root, &profile_id)?.list_configurations()?;
        serde_json::to_string(&configurations)
            .map_err(|_| "Could not encode the widget configurations.".to_string())
    }));
    widget_jni_string_result(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_com_azazel_collab_companion_CollabWidgetBridge_nativeSaveConfiguration(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    context: JObject<'_>,
    profile_id: JString<'_>,
    configuration_json: JString<'_>,
) -> jstring {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        register_worker_context(&mut env, &context)?;
        let profile_id = env
            .get_string(&profile_id)
            .map_err(|_| "Could not decode the widget profile identifier.".to_string())?
            .to_string_lossy()
            .into_owned();
        let raw = env
            .get_string(&configuration_json)
            .map_err(|_| "Could not decode the widget configuration.".to_string())?
            .to_string_lossy()
            .into_owned();
        if raw.len() > 64 * 1024 {
            return Err("The widget configuration exceeded its size limit.".into());
        }
        let configuration: crate::widgets::WidgetConfiguration = serde_json::from_str(&raw)
            .map_err(|_| "The widget configuration is invalid.".to_string())?;
        let root = files_dir()?.join("collab");
        let saved = crate::widgets::WidgetStore::open(&root, &profile_id)?
            .save_configuration(configuration)?;
        serde_json::to_string(&saved)
            .map_err(|_| "Could not encode the widget configuration.".to_string())
    }));
    widget_jni_string_result(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_com_azazel_collab_companion_CollabWidgetBridge_nativeDeleteConfiguration(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    context: JObject<'_>,
    profile_id: JString<'_>,
    configuration_id: JString<'_>,
) -> jboolean {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        register_worker_context(&mut env, &context)?;
        let profile_id = env
            .get_string(&profile_id)
            .map_err(|_| "Could not decode the widget profile identifier.".to_string())?
            .to_string_lossy()
            .into_owned();
        let configuration_id = env
            .get_string(&configuration_id)
            .map_err(|_| "Could not decode the widget configuration identifier.".to_string())?
            .to_string_lossy()
            .into_owned();
        let root = files_dir()?.join("collab");
        crate::widgets::WidgetStore::open(&root, &profile_id)?
            .delete_configuration(&configuration_id)
    }));
    match result {
        Ok(Ok(true)) => JNI_TRUE,
        Ok(Ok(false)) => JNI_FALSE,
        Ok(Err(error)) => {
            let _ = env.throw_new("java/lang/IllegalArgumentException", error);
            JNI_FALSE
        }
        Err(_) => {
            let _ = env.throw_new(
                "java/lang/IllegalStateException",
                "The native widget configuration delete failed.",
            );
            JNI_FALSE
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_com_azazel_collab_companion_CollabWidgetBridge_nativeBuildAndPublish(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    context: JObject<'_>,
    profile_id: JString<'_>,
    request_json: JString<'_>,
) -> jstring {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        register_worker_context(&mut env, &context)?;
        let profile_id = env
            .get_string(&profile_id)
            .map_err(|_| "Could not decode the widget profile identifier.".to_string())?
            .to_string_lossy()
            .into_owned();
        let raw = env
            .get_string(&request_json)
            .map_err(|_| "Could not decode the widget publication request.".to_string())?
            .to_string_lossy()
            .into_owned();
        if raw.len() > 64 * 1024 {
            return Err("The widget publication request exceeded its size limit.".into());
        }
        let request: crate::widgets::WidgetBuildRequest = serde_json::from_str(&raw)
            .map_err(|_| "The widget publication request is invalid.".to_string())?;
        let snapshot = crate::widgets::build_snapshot(&profile_id, request)?;
        let root = files_dir()?.join("collab");
        let outcome = crate::widgets::WidgetStore::open(&root, &profile_id)?.publish(snapshot)?;
        serde_json::to_string(&outcome)
            .map_err(|_| "Could not encode the widget publication result.".to_string())
    }));
    widget_jni_string_result(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_com_azazel_collab_companion_CollabWidgetBridge_nativePublishAgendaProfile(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    context: JObject<'_>,
    profile_id: JString<'_>,
    update_cause: JString<'_>,
) -> jstring {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        register_worker_context(&mut env, &context)?;
        let profile_id = env
            .get_string(&profile_id)
            .map_err(|_| "Could not decode the widget profile identifier.".to_string())?
            .to_string_lossy()
            .into_owned();
        let update_cause = env
            .get_string(&update_cause)
            .map_err(|_| "Could not decode the widget update cause.".to_string())?
            .to_string_lossy()
            .into_owned();
        let root = files_dir()?.join("collab");
        let now = chrono::Utc::now();
        let publication = tauri::async_runtime::block_on(async {
            let calendar_store = crate::commands::calendar::store(&profile_id).await?;
            crate::widgets::build_and_publish_agenda_profile(
                &root,
                &profile_id,
                &calendar_store,
                now,
                &update_cause,
            )
            .await
        });
        let outcomes = match publication {
            Ok(outcomes) => outcomes,
            Err(error) => {
                if let Ok(store) = crate::widgets::WidgetStore::open(&root, &profile_id) {
                    let _ = store.record_refresh_failure(&now.to_rfc3339(), &update_cause);
                }
                return Err(error);
            }
        };
        serde_json::to_string(&serde_json::json!({
            "configured": !outcomes.is_empty(),
            "changed": outcomes.iter().any(|outcome| outcome.changed),
        }))
        .map_err(|_| "Could not encode the widget publication result.".to_string())
    }));
    widget_jni_string_result(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_com_azazel_collab_companion_CollabWidgetBridge_nativeReadSnapshot(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    context: JObject<'_>,
    profile_id: JString<'_>,
    configuration_id: JString<'_>,
) -> jstring {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        register_worker_context(&mut env, &context)?;
        let profile_id = env
            .get_string(&profile_id)
            .map_err(|_| "Could not decode the widget profile identifier.".to_string())?
            .to_string_lossy()
            .into_owned();
        let configuration_id = env
            .get_string(&configuration_id)
            .map_err(|_| "Could not decode the widget configuration identifier.".to_string())?
            .to_string_lossy()
            .into_owned();
        let root = files_dir()?.join("collab");
        let snapshot = crate::widgets::WidgetStore::open(&root, &profile_id)?
            .read_snapshot(&configuration_id)?;
        serde_json::to_string(&snapshot)
            .map_err(|_| "Could not encode the widget snapshot.".to_string())
    }));
    widget_jni_string_result(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_com_azazel_collab_companion_CollabWidgetBridge_nativePrepareAction(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    context: JObject<'_>,
    profile_id: JString<'_>,
    request_json: JString<'_>,
) -> jstring {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        register_worker_context(&mut env, &context)?;
        let profile_id = env
            .get_string(&profile_id)
            .map_err(|_| "Could not decode the widget profile identifier.".to_string())?
            .to_string_lossy()
            .into_owned();
        let raw = env
            .get_string(&request_json)
            .map_err(|_| "Could not decode the widget action request.".to_string())?
            .to_string_lossy()
            .into_owned();
        if raw.len() > 1024 {
            return Err("The widget action request exceeded its size limit.".into());
        }
        let request: crate::widgets::WidgetActionRequest = serde_json::from_str(&raw)
            .map_err(|_| "The widget action request is invalid.".to_string())?;
        let root = files_dir()?.join("collab");
        let action =
            crate::widgets::WidgetStore::open(&root, &profile_id)?.prepare_action(request)?;
        serde_json::to_string(&action)
            .map_err(|_| "Could not encode the widget action.".to_string())
    }));
    widget_jni_string_result(&mut env, result)
}

/// Enqueues a user-initiated synchronization for one profile from the launcher.
///
/// The widget never syncs anything itself: it hands the request to the same
/// WorkManager chain the app and the scheduler use, under the same unique work
/// name and the same settings-derived constraints. Repeated taps therefore join
/// the existing run rather than starting a parallel one, and no launcher tap can
/// make work run on a network or battery state the user excluded.
#[no_mangle]
pub extern "system" fn Java_com_azazel_collab_companion_CollabWidgetBridge_nativeRequestSync(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    context: JObject<'_>,
    profile_id: JString<'_>,
) -> jstring {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        register_worker_context(&mut env, &context)?;
        let profile_id = env
            .get_string(&profile_id)
            .map_err(|_| "Could not decode the widget profile identifier.".to_string())?
            .to_string_lossy()
            .into_owned();
        let root = files_dir()?.join("collab");
        let settings = crate::background::read_ledger_view(&root)?.settings;
        request_immediate_background_work(
            &profile_id,
            true,
            settings.only_unmetered_networks,
            settings.require_charging,
            settings.pause_on_low_battery,
            settings.allow_roaming,
        )?;
        serde_json::to_string(&serde_json::json!({ "requested": true }))
            .map_err(|_| "Could not encode the sync request result.".to_string())
    }));
    widget_jni_string_result(&mut env, result)
}

/// Applies a launcher-confirmed task completion and republishes the affected
/// snapshots, so the widget only ever renders state the native queue accepted.
#[no_mangle]
pub extern "system" fn Java_com_azazel_collab_companion_CollabWidgetBridge_nativeCompleteTask(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    context: JObject<'_>,
    profile_id: JString<'_>,
    request_json: JString<'_>,
) -> jstring {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        register_worker_context(&mut env, &context)?;
        let profile_id = env
            .get_string(&profile_id)
            .map_err(|_| "Could not decode the widget profile identifier.".to_string())?
            .to_string_lossy()
            .into_owned();
        let raw = env
            .get_string(&request_json)
            .map_err(|_| "Could not decode the task completion request.".to_string())?
            .to_string_lossy()
            .into_owned();
        if raw.len() > 1024 {
            return Err("The task completion request exceeded its size limit.".into());
        }
        let request: crate::widgets::WidgetTaskCompletionRequest = serde_json::from_str(&raw)
            .map_err(|_| "The task completion request is invalid.".to_string())?;
        let root = files_dir()?.join("collab");
        let now = chrono::Utc::now();
        let outcome = tauri::async_runtime::block_on(async {
            let calendar_store = crate::commands::calendar::store(&profile_id).await?;
            let result =
                crate::widgets::complete_task(&root, &profile_id, &calendar_store, request, now)
                    .await?;
            // Republish before returning so the confirming tap and the rendered
            // rows can never disagree about what was actually applied.
            crate::widgets::build_and_publish_agenda_profile(
                &root,
                &profile_id,
                &calendar_store,
                now,
                "task-action",
            )
            .await?;
            Ok::<_, String>(result)
        })?;
        serde_json::to_string(&outcome)
            .map_err(|_| "Could not encode the task completion result.".to_string())
    }));
    widget_jni_string_result(&mut env, result)
}

fn widget_jni_string_result(
    env: &mut JNIEnv<'_>,
    result: Result<Result<String, String>, Box<dyn std::any::Any + Send>>,
) -> jstring {
    match result {
        Ok(Ok(payload)) => env
            .new_string(payload)
            .map(JString::into_raw)
            .unwrap_or(std::ptr::null_mut()),
        Ok(Err(error)) => {
            let _ = env.throw_new("java/lang/IllegalArgumentException", error);
            std::ptr::null_mut()
        }
        Err(_) => {
            let _ = env.throw_new(
                "java/lang/IllegalStateException",
                "The native widget operation failed.",
            );
            std::ptr::null_mut()
        }
    }
}
