//! Small shared JNI helpers for calling the companion app's Kotlin secret-store
//! classes from Rust on Android. Both the refresh-token store
//! (`server_token_store`) and the offline-replica key store (`commands/replica`)
//! call static Kotlin methods that take the app `Context` plus one or more
//! `String` arguments and return a nullable `String`, so that pattern is shared
//! here instead of forked per store.

#![cfg(target_os = "android")]

use jni::objects::{JClass, JObject, JString, JValue};
use jni::sys::jstring;
use jni::{JNIEnv, JavaVM};
use std::mem::ManuallyDrop;

/// Runs `callback` with an attached JNI environment and the app `Context`.
fn with_env<T>(
    callback: impl for<'local> FnOnce(&mut JNIEnv<'local>, &JObject<'local>) -> Result<T, String>,
) -> Result<T, String> {
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
