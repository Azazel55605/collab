package com.azazel.collab.companion

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.google.android.material.button.MaterialButton
import com.google.android.material.card.MaterialCardView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.time.Instant
import java.util.UUID

internal object WidgetSetupPalette {
  var background = rgb(12, 15, 22)
  var card = rgb(19, 22, 29)
  var surface = rgb(23, 27, 34)
  var sidebar = rgb(9, 12, 18)
  var selectedSurface = rgb(40, 34, 60)
  var foreground = rgb(228, 232, 239)
  var muted = rgb(128, 134, 147)
  var border = rgb(45, 48, 55)
  var primary = rgb(161, 116, 255)
  var primaryPressed = rgb(130, 96, 204)
  var primaryForeground = rgb(3, 3, 3)
  var danger = rgb(248, 113, 113)
  var fontScale = 1f
  var isLight = false

  fun apply(raw: String?) {
    val value = runCatching {
      if (raw == null || raw == "null") null else org.json.JSONObject(raw)
    }.getOrNull()
    val theme = value?.optString("theme", "dark") ?: "dark"
    val colors = when (theme) {
      "midnight" -> intArrayOf(
        rgb(1, 1, 1),
        rgb(3, 3, 3),
        rgb(5, 6, 7),
        rgb(1, 1, 1),
        rgb(222, 222, 222),
        rgb(111, 114, 120),
        rgb(23, 23, 23),
      )
      "warm" -> intArrayOf(
        rgb(9, 3, 1),
        rgb(15, 7, 3),
        rgb(20, 11, 5),
        rgb(7, 2, 1),
        rgb(239, 226, 216),
        rgb(142, 124, 111),
        rgb(36, 29, 24),
      )
      "light" -> intArrayOf(
        rgb(245, 245, 245),
        rgb(255, 255, 255),
        rgb(252, 252, 252),
        rgb(235, 235, 235),
        rgb(9, 9, 9),
        rgb(82, 85, 91),
        rgb(220, 220, 220),
      )
      else -> intArrayOf(
        rgb(12, 15, 22),
        rgb(19, 22, 29),
        rgb(23, 27, 34),
        rgb(9, 12, 18),
        rgb(228, 232, 239),
        rgb(128, 134, 147),
        rgb(45, 48, 55),
      )
    }
    background = colors[0]
    card = colors[1]
    surface = colors[2]
    sidebar = colors[3]
    foreground = colors[4]
    muted = colors[5]
    border = colors[6]
    isLight = theme == "light"
    primary = when (value?.optString("accent", "violet")) {
      "blue" -> rgb(0, 155, 242)
      "emerald" -> rgb(0, 196, 131)
      "rose" -> rgb(250, 65, 107)
      "orange" -> rgb(250, 124, 32)
      "cyan" -> rgb(0, 196, 205)
      else -> rgb(161, 116, 255)
    }
    selectedSurface = blend(card, primary, if (isLight) 0.1f else 0.18f)
    primaryPressed = blend(primary, background, 0.2f)
    primaryForeground = if (isLight) rgb(255, 255, 255) else rgb(3, 3, 3)
    fontScale = value?.optDouble("fontScale", 1.0)?.toFloat()?.coerceIn(0.85f, 1.3f) ?: 1f
  }

  private fun rgb(red: Int, green: Int, blue: Int): Int =
    (0xff shl 24) or (red shl 16) or (green shl 8) or blue

  private fun blend(from: Int, to: Int, ratio: Float): Int {
    val inverse = 1f - ratio
    val red = (((from shr 16) and 0xff) * inverse + ((to shr 16) and 0xff) * ratio).toInt()
    val green = (((from shr 8) and 0xff) * inverse + ((to shr 8) and 0xff) * ratio).toInt()
    val blue = ((from and 0xff) * inverse + (to and 0xff) * ratio).toInt()
    return rgb(red, green, blue)
  }
}

private data class PrivacyChoice(
  val value: String,
  val title: String,
  val description: String,
  val previewTitle: String,
  val previewDetail: String,
)

private data class PrivacyChoiceView(
  val choice: PrivacyChoice,
  val card: MaterialCardView,
  val indicator: TextView,
)

class CollabWidgetConfigurationActivity : Activity() {
  private var appWidgetId = AppWidgetManager.INVALID_APPWIDGET_ID
  private var widgetKind = "agenda"
  private var saving = false

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    WidgetSetupPalette.apply(
      runCatching { CollabWidgetBridge.nativeReadAppearance(applicationContext) }.getOrNull(),
    )
    WindowCompat.setDecorFitsSystemWindows(window, false)
    WindowInsetsControllerCompat(window, window.decorView).apply {
      isAppearanceLightStatusBars = WidgetSetupPalette.isLight
      isAppearanceLightNavigationBars = WidgetSetupPalette.isLight
    }
    setResult(RESULT_CANCELED)
    appWidgetId = intent?.getIntExtra(
      AppWidgetManager.EXTRA_APPWIDGET_ID,
      AppWidgetManager.INVALID_APPWIDGET_ID,
    ) ?: AppWidgetManager.INVALID_APPWIDGET_ID
    if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
      finish()
      return
    }
    widgetKind = widgetKindForId(this, appWidgetId)

    val profileId = runCatching {
      CollabWidgetBridge.nativeActiveProfile(applicationContext)
    }.getOrNull()
    if (profileId == null) {
      showMissingProfile()
      return
    }
    showConfiguration(profileId)
  }

  private fun showMissingProfile() {
    val content = screenContent()
    content.addView(brandHeader())
    content.addView(title("One quick step"), spaced(top = 34))
    content.addView(
      body("Open Collab once so this widget can attach to your local profile."),
      spaced(top = 10),
    )
    content.addView(
      messageCard(
        "Profile not ready",
        "Return to the launcher after opening Collab, then add the Agenda widget again.",
      ),
      spaced(top = 28),
    )
    content.addView(primaryButton("Close") { finish() }, spaced(top = 24, bottom = 8))
    setContentView(scrollScreen(content))
  }

  private fun showConfiguration(profileId: String) {
    val widgetTitle = when (widgetKind) {
      "month" -> "Month calendar"
      "birthday" -> "Birthdays"
      "countdown" -> "Countdowns"
      "tasks" -> "Tasks"
      "capture" -> "Quick capture"
      "shortcuts" -> "Shortcuts"
      else -> "Agenda"
    }
    val choices = listOf(
      PrivacyChoice(
        "full",
        "Full details",
        "Show event titles, times, and permitted details.",
        "Design review",
        "09:30 · Event",
      ),
      PrivacyChoice(
        "titleOnly",
        "Titles only",
        "Keep titles and hide source or location details.",
        "Design review",
        "09:30",
      ),
      PrivacyChoice(
        "private",
        "Private",
        "Replace personal content with a generic item label.",
        "Private item",
        "09:30",
      ),
    )
    val existingConfiguration = existingConfiguration(profileId)
    var selected = choices.firstOrNull {
      it.value == existingConfiguration?.optString("privacy")
    } ?: choices.first()
    val content = screenContent()
    content.addView(brandHeader())
    content.addView(title("Set up $widgetTitle"), spaced(top = 30))
    content.addView(
      body(
        when (widgetKind) {
          "countdown" ->
            "Choose launcher privacy here, then select countdown events in Collab Settings."
          "tasks" ->
            "Choose launcher privacy here. Task sources and the optional complete action are set in Collab Settings."
          "capture" ->
            "Choose launcher privacy here, then pick which create shortcuts appear in Collab Settings."
          "shortcuts" ->
            "Choose launcher privacy here, then pin the files you want in Collab Settings."
          else ->
            "Choose what Collab may place in launcher-visible storage. You can change this later in Settings."
        },
      ),
      spaced(top = 9),
    )

    val previewTitle = label(selected.previewTitle, 15f, WidgetSetupPalette.foreground, medium = true)
    val previewDetail = label(selected.previewDetail, 13f, WidgetSetupPalette.muted)
    content.addView(widgetPreview(previewTitle, previewDetail), spaced(top = 24))

    content.addView(sectionLabel("PRIVACY"), spaced(top = 28, bottom = 10))
    val optionContainer = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
    }
    val optionViews = mutableListOf<PrivacyChoiceView>()
    choices.forEach { choice ->
      val option = privacyChoice(choice)
      option.card.setOnClickListener {
        selected = choice
        previewTitle.text = choice.previewTitle
        previewDetail.text = choice.previewDetail
        updateChoices(optionViews, selected)
      }
      optionViews.add(option)
      optionContainer.addView(option.card, spaced(bottom = 9))
    }
    updateChoices(optionViews, selected)
    content.addView(optionContainer)

    val errorText = label("", 13f, WidgetSetupPalette.danger).apply {
      visibility = View.GONE
      gravity = Gravity.CENTER
    }
    val addButton = primaryButton("Apply") {
      if (saving) return@primaryButton
      saving = true
      errorText.visibility = View.GONE
      save(profileId, selected.value, existingConfiguration) { error ->
        if (error != null) {
          saving = false
          errorText.text = "Could not apply the widget: $error"
          errorText.visibility = View.VISIBLE
        }
      }
    }
    content.addView(addButton, spaced(top = 18))
    content.addView(errorText, spaced(top = 10))
    content.addView(secondaryButton("Cancel") { finish() }, spaced(top = 4, bottom = 12))
    setContentView(scrollScreen(content))
  }

  private fun existingConfiguration(profileId: String): org.json.JSONObject? {
    val binding = CollabWidgetBindings.read(this, appWidgetId)
      ?.takeIf { it.profileId == profileId }
      ?: return null
    val configurations = runCatching {
      org.json.JSONArray(CollabWidgetBridge.nativeListConfigurations(applicationContext, profileId))
    }.getOrNull() ?: return null
    for (index in 0 until configurations.length()) {
      val configuration = configurations.optJSONObject(index) ?: continue
      if (configuration.optString("configurationId") == binding.configurationId) {
        return configuration
      }
    }
    return null
  }

  private fun save(
    profileId: String,
    privacy: String,
    existingConfiguration: org.json.JSONObject?,
    completed: (String?) -> Unit,
  ) {
    val configuration = existingConfiguration
      ?.let { org.json.JSONObject(it.toString()) }
      ?: org.json.JSONObject()
        .put("schemaVersion", 1)
        .put("configurationId", "widget-${UUID.randomUUID()}")
        .put("kind", widgetKind)
        .put("selectedSourceIds", org.json.JSONArray())
        .put("selectedItemIds", org.json.JSONArray())
        .put(
          "display",
          org.json.JSONObject()
            .put("horizonDays", when (widgetKind) {
              "month" -> 42
              "birthday", "countdown" -> 366
              "tasks" -> 14
              "capture", "shortcuts" -> 366
              else -> 7
            })
            .put("maxItems", 6)
            .put("showCompleted", false),
        )
        .put(
          "actions",
          org.json.JSONObject().put("openItem", true).put("toggleTask", false),
        )
    configuration
      .put("privacy", privacy)
      .put("updatedAt", Instant.now().toString())
    val configurationId = configuration.getString("configurationId")
    val saved = runCatching {
      CollabWidgetBridge.nativeSaveConfiguration(
        applicationContext,
        profileId,
        configuration.toString(),
      )
    }.isSuccess
    if (!saved) {
      completed("The configuration could not be saved.")
      return
    }
    if (!CollabWidgetBindings.save(this, appWidgetId, WidgetBinding(profileId, configurationId))) {
      completed("The launcher binding could not be saved.")
      return
    }
    runCatching { CollabWidgetRefreshScheduler.reconcile(applicationContext) }
    CollabWidgetBridge.publishConfiguration(
      applicationContext,
      profileId,
    ) { error ->
      if (error != null) {
        completed(error)
        return@publishConfiguration
      }
      setResult(
        RESULT_OK,
        Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId),
      )
      completed(null)
      finish()
    }
  }

  private fun screenContent() = LinearLayout(this).apply {
    orientation = LinearLayout.VERTICAL
    setPadding(dp(20), dp(22), dp(20), dp(22))
  }

  private fun scrollScreen(content: View): ScrollView = ScrollView(this).apply {
    isFillViewport = true
    clipToPadding = false
    setBackgroundColor(WidgetSetupPalette.background)
    ViewCompat.setOnApplyWindowInsetsListener(this) { view, windowInsets ->
      val systemBars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars())
      view.setPadding(0, systemBars.top, 0, systemBars.bottom)
      windowInsets
    }
    addView(
      content,
      ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT),
    )
  }

  private fun brandHeader(): LinearLayout = LinearLayout(this).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    addView(
      TextView(this@CollabWidgetConfigurationActivity).apply {
        text = "C"
        textSize = 16f * WidgetSetupPalette.fontScale
        gravity = Gravity.CENTER
        setTextColor(WidgetSetupPalette.primaryForeground)
        typeface = Typeface.create("sans-serif", Typeface.BOLD)
        background = rounded(WidgetSetupPalette.primary, 11)
      },
      LinearLayout.LayoutParams(dp(36), dp(36)),
    )
    addView(
      LinearLayout(this@CollabWidgetConfigurationActivity).apply {
        orientation = LinearLayout.VERTICAL
        addView(label("COLLAB", 12f, WidgetSetupPalette.foreground, medium = true).apply {
          letterSpacing = 0.12f
        })
        addView(label("Companion", 12f, WidgetSetupPalette.muted))
      },
      LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
        marginStart = dp(11)
      },
    )
    addView(
      label("WIDGET", 10f, WidgetSetupPalette.primary, medium = true).apply {
        letterSpacing = 0.1f
        setPadding(dp(10), dp(6), dp(10), dp(6))
        background = rounded(WidgetSetupPalette.selectedSurface, 20, WidgetSetupPalette.border)
      },
    )
  }

  private fun widgetPreview(previewTitle: TextView, previewDetail: TextView): MaterialCardView =
    MaterialCardView(this).apply {
      radius = dp(18).toFloat()
      cardElevation = 0f
      setCardBackgroundColor(WidgetSetupPalette.sidebar)
      strokeColor = WidgetSetupPalette.border
      strokeWidth = dp(1)
      addView(
        LinearLayout(this@CollabWidgetConfigurationActivity).apply {
          orientation = LinearLayout.VERTICAL
          setPadding(dp(17), dp(15), dp(17), dp(16))
          addView(
            LinearLayout(this@CollabWidgetConfigurationActivity).apply {
              gravity = Gravity.CENTER_VERTICAL
              addView(label("TODAY", 11f, WidgetSetupPalette.primary, medium = true).apply {
                letterSpacing = 0.1f
              })
              addView(
                label("PREVIEW", 10f, WidgetSetupPalette.muted, medium = true).apply {
                  letterSpacing = 0.08f
                  gravity = Gravity.END
                },
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
              )
            },
          )
          addView(previewTitle, spaced(top = 13))
          addView(previewDetail, spaced(top = 3))
        },
      )
    }

  private fun privacyChoice(choice: PrivacyChoice): PrivacyChoiceView {
    val indicator = label("", 13f, WidgetSetupPalette.primaryForeground, medium = true).apply {
      gravity = Gravity.CENTER
    }
    val card = MaterialCardView(this).apply {
      radius = dp(14).toFloat()
      cardElevation = 0f
      strokeWidth = dp(1)
      isClickable = true
      isFocusable = true
      contentDescription = "${choice.title}. ${choice.description}"
      addView(
        LinearLayout(this@CollabWidgetConfigurationActivity).apply {
          orientation = LinearLayout.HORIZONTAL
          gravity = Gravity.CENTER_VERTICAL
          setPadding(dp(15), dp(13), dp(13), dp(13))
          addView(
            LinearLayout(this@CollabWidgetConfigurationActivity).apply {
              orientation = LinearLayout.VERTICAL
              addView(label(choice.title, 15f, WidgetSetupPalette.foreground, medium = true))
              addView(label(choice.description, 12.5f, WidgetSetupPalette.muted), spaced(top = 3))
            },
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
          )
          addView(indicator, LinearLayout.LayoutParams(dp(24), dp(24)).apply {
            marginStart = dp(12)
          })
        },
      )
    }
    return PrivacyChoiceView(choice, card, indicator)
  }

  private fun updateChoices(optionViews: List<PrivacyChoiceView>, selected: PrivacyChoice) {
    optionViews.forEach { option ->
      val isSelected = option.choice.value == selected.value
      option.card.setCardBackgroundColor(
        if (isSelected) WidgetSetupPalette.selectedSurface else WidgetSetupPalette.card,
      )
      option.card.strokeColor = if (isSelected) WidgetSetupPalette.primary else WidgetSetupPalette.border
      option.card.strokeWidth = dp(if (isSelected) 2 else 1)
      option.indicator.text = if (isSelected) "✓" else ""
      option.indicator.background = if (isSelected) {
        rounded(WidgetSetupPalette.primary, 20)
      } else {
        rounded(Color.TRANSPARENT, 20, WidgetSetupPalette.border)
      }
      option.card.isSelected = isSelected
    }
  }

  private fun messageCard(heading: String, message: String): MaterialCardView =
    MaterialCardView(this).apply {
      radius = dp(16).toFloat()
      cardElevation = 0f
      setCardBackgroundColor(WidgetSetupPalette.card)
      strokeColor = WidgetSetupPalette.border
      strokeWidth = dp(1)
      addView(
        LinearLayout(this@CollabWidgetConfigurationActivity).apply {
          orientation = LinearLayout.VERTICAL
          setPadding(dp(17), dp(16), dp(17), dp(17))
          addView(label(heading, 15f, WidgetSetupPalette.foreground, medium = true))
          addView(label(message, 13.5f, WidgetSetupPalette.muted), spaced(top = 6))
        },
      )
    }

  private fun primaryButton(text: String, action: () -> Unit): MaterialButton =
    MaterialButton(this).apply {
      this.text = text
      textSize = 15f * WidgetSetupPalette.fontScale
      isAllCaps = false
      typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
      setTextColor(WidgetSetupPalette.primaryForeground)
      backgroundTintList = android.content.res.ColorStateList.valueOf(WidgetSetupPalette.primary)
      cornerRadius = dp(14)
      insetTop = 0
      insetBottom = 0
      minHeight = dp(52)
      rippleColor = android.content.res.ColorStateList.valueOf(WidgetSetupPalette.primaryPressed)
      setOnClickListener { action() }
    }

  private fun secondaryButton(text: String, action: () -> Unit): MaterialButton =
    MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
      this.text = text
      textSize = 14f * WidgetSetupPalette.fontScale
      isAllCaps = false
      typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
      setTextColor(WidgetSetupPalette.muted)
      setBackgroundColor(Color.TRANSPARENT)
      strokeWidth = 0
      minHeight = dp(46)
      setOnClickListener { action() }
    }

  private fun title(text: String) = label(text, 28f, WidgetSetupPalette.foreground, medium = true)

  private fun body(text: String) = label(text, 14.5f, WidgetSetupPalette.muted).apply {
    setLineSpacing(0f, 1.15f)
  }

  private fun sectionLabel(text: String) = label(text, 11f, WidgetSetupPalette.muted, medium = true).apply {
    letterSpacing = 0.12f
  }

  private fun label(text: String, size: Float, color: Int, medium: Boolean = false) = TextView(this).apply {
    this.text = text
    textSize = size * WidgetSetupPalette.fontScale
    setTextColor(color)
    typeface = Typeface.create(if (medium) "sans-serif-medium" else "sans-serif", Typeface.NORMAL)
  }

  private fun rounded(fill: Int, radius: Int, stroke: Int? = null) = GradientDrawable().apply {
    shape = GradientDrawable.RECTANGLE
    setColor(fill)
    cornerRadius = dp(radius).toFloat()
    if (stroke != null) setStroke(dp(1), stroke)
  }

  private fun spaced(
    top: Int = 0,
    bottom: Int = 0,
  ) = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
    topMargin = dp(top)
    bottomMargin = dp(bottom)
  }

  private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
