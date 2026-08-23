package com.umerzia.commanddeck

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import com.umerzia.commanddeck.ui.DeckScreen
import com.umerzia.commanddeck.ui.SignInScreen
import com.umerzia.commanddeck.ui.theme.CommandDeckTheme

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        setContent {
            CommandDeckTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    val vm: DeckViewModel = viewModel()
                    val user by vm.auth.user.collectAsState()
                    val restoring by vm.auth.isRestoring.collectAsState()

                    when {
                        // Without this the sign-in screen flashes on every
                        // cold launch before Firebase restores the session.
                        restoring -> Box(
                            Modifier.fillMaxSize(),
                            contentAlignment = Alignment.Center
                        ) { CircularProgressIndicator() }

                        user == null -> SignInScreen(vm)

                        else -> DeckScreen(vm)
                    }
                }
            }
        }
    }
}
