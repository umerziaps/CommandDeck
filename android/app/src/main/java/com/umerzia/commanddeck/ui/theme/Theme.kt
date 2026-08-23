package com.umerzia.commanddeck.ui.theme

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

// The Command Deck palette, carried over hex-for-hex from the web version
// and the iOS app so all three look like the same product.

object Deck {
    val nowDark = Color(0xFF5EE6C5)
    val laterDark = Color(0xFF7C89F0)
    val waitingDark = Color(0xFFF0B45E)
    val signalDark = Color(0xFFFF6B54)

    val nowLight = Color(0xFF12A886)
    val laterLight = Color(0xFF5566D8)
    val waitingLight = Color(0xFFB5791A)
    val signalLight = Color(0xFFE5522F)
}

private val DarkColors = darkColorScheme(
    primary = Deck.nowDark,
    onPrimary = Color(0xFF04120E),
    background = Color(0xFF0F1216),
    onBackground = Color(0xFFEDF0F3),
    surface = Color(0xFF161A21),
    onSurface = Color(0xFFEDF0F3),
    surfaceVariant = Color(0xFF1E232C),
    onSurfaceVariant = Color(0xFF9BA3AE),
    outline = Color(0xFF646C78),
    error = Deck.signalDark,
)

private val LightColors = lightColorScheme(
    primary = Deck.nowLight,
    onPrimary = Color.White,
    background = Color(0xFFF5F6F8),
    onBackground = Color(0xFF141619),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF141619),
    surfaceVariant = Color(0xFFF0F2F5),
    onSurfaceVariant = Color(0xFF525A64),
    outline = Color(0xFF8A929C),
    error = Deck.signalLight,
)

/** Bucket accents resolved for the current theme. */
@Composable
fun bucketColors(dark: Boolean = isSystemInDarkTheme()) = Triple(
    if (dark) Deck.nowDark else Deck.nowLight,
    if (dark) Deck.waitingDark else Deck.waitingLight,
    if (dark) Deck.laterDark else Deck.laterLight,
)

@Composable
fun signalColor(dark: Boolean = isSystemInDarkTheme()): Color =
    if (dark) Deck.signalDark else Deck.signalLight

@Composable
fun CommandDeckTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    val colors = if (darkTheme) DarkColors else LightColors
    val view = LocalView.current

    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            window.statusBarColor = colors.background.toArgb()
            WindowCompat.getInsetsController(window, view)
                .isAppearanceLightStatusBars = !darkTheme
        }
    }

    MaterialTheme(colorScheme = colors, content = content)
}
