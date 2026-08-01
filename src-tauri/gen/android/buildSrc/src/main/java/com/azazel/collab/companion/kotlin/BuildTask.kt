import java.io.File
import javax.inject.Inject
import org.apache.tools.ant.taskdefs.condition.Os
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.logging.LogLevel
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.TaskAction
import org.gradle.process.ExecOperations

open class BuildTask @Inject constructor(
    private val execOperations: ExecOperations,
) : DefaultTask() {
    @Input
    var rootDirRel: String? = null
    @Internal
    var projectDirPath: String? = null
    @Input
    var target: String? = null
    @Input
    var release: Boolean? = null

    @TaskAction
    fun assemble() {
        val executable = """node""";
        try {
            runTauriCli(executable)
        } catch (e: Exception) {
            if (Os.isFamily(Os.FAMILY_WINDOWS)) {
                // Try different Windows-specific extensions
                val fallbacks = listOf(
                    "$executable.exe",
                    "$executable.cmd",
                    "$executable.bat",
                )
                
                var lastException: Exception = e
                for (fallback in fallbacks) {
                    try {
                        runTauriCli(fallback)
                        return
                    } catch (fallbackException: Exception) {
                        lastException = fallbackException
                    }
                }
                throw lastException
            } else {
                throw e;
            }
        }
    }

    fun runTauriCli(executable: String) {
        val rootDirRel = rootDirRel ?: throw GradleException("rootDirRel cannot be null")
        val target = target ?: throw GradleException("target cannot be null")
        val release = release ?: throw GradleException("release cannot be null")

        val projectDirPath = projectDirPath ?: throw GradleException("projectDirPath cannot be null")
        execOperations.exec {
            workingDir(File(projectDirPath, rootDirRel))
            executable(executable)
            val nodeOptions = System.getenv("NODE_OPTIONS").orEmpty()
            val heapOption = "--max-old-space-size=8192"
            environment(
                "NODE_OPTIONS",
                if (nodeOptions.contains("--max-old-space-size")) nodeOptions else "$nodeOptions $heapOption".trim()
            )
            args(listOf("../scripts/tauri-command.mjs", "android", "android-studio-script"))
            if (logger.isEnabled(LogLevel.DEBUG)) {
                args("-vv")
            } else if (logger.isEnabled(LogLevel.INFO)) {
                args("-v")
            }
            if (release) {
                args("--release")
            }
            args(listOf("--target", target))
        }.assertNormalExitValue()
    }
}
