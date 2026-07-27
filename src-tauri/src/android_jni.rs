//! Small shared JNI helpers for calling the companion app's Kotlin secret-store
//! classes from Rust on Android. Both the refresh-token store
//! (`server_token_store`) and the offline-replica key store (`commands/replica`)
//! call static Kotlin methods that take the app `Context` plus one or more
//! `String` arguments and return a nullable `String`, so that pattern is shared
//! here instead of forked per store.

#![cfg(target_os = "android")]

use jni::objects::{GlobalRef, JClass, JObject, JString, JValue};
use jni::sys::jstring;
use jni::{JNIEnv, JavaVM};
use std::mem::ManuallyDrop;
use std::path::PathBuf;
use std::sync::OnceLock;

struct AndroidWorkerContext {
    java_vm: JavaVM,
    context: GlobalRef,
}

static WORKER_CONTEXT: OnceLock<AndroidWorkerContext> = OnceLock::new();

fn register_worker_context(env: &mut JNIEnv<'_>, context: &JObject<'_>) -> Result<(), String> {
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

pub fn configure_background_scheduler(
    profile_id: &str,
    enabled: bool,
    interval: &str,
) -> Result<(), String> {
    match call_static_string(
        BACKGROUND_SCHEDULER_CLASS,
        "configure",
        &[profile_id, if enabled { "true" } else { "false" }, interval],
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
) -> Result<(), String> {
    match call_static_string(
        BACKGROUND_SCHEDULER_CLASS,
        "requestImmediate",
        &[profile_id, if user_initiated { "true" } else { "false" }],
    )? {
        Some(error) => Err(format!(
            "Could not request Android background work: {error}"
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
            "catch-up" | "user-initiated" => crate::background::BackgroundJobTrigger::UserInitiated,
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
