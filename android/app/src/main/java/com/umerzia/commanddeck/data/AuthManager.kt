package com.umerzia.commanddeck.data

import android.content.Context
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseUser
import com.google.firebase.auth.GoogleAuthProvider
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.tasks.await

/**
 * Google sign-in via Credential Manager, exchanged for a Firebase session.
 *
 * Credential Manager replaced the old GoogleSignInClient API. The flow is:
 * ask Google for an ID token → hand that token to Firebase Auth → get back
 * a UID. That UID is the same one the iOS and web clients get for the same
 * Google account, which is what makes `users/{uid}/…` one shared board
 * rather than three separate ones.
 */
class AuthManager(context: Context) {

    private val auth = FirebaseAuth.getInstance()
    private val credentialManager = CredentialManager.create(context.applicationContext)

    private val _user = MutableStateFlow(auth.currentUser)
    val user: StateFlow<FirebaseUser?> = _user.asStateFlow()

    /** True until Firebase has restored (or failed to restore) a session. */
    private val _isRestoring = MutableStateFlow(true)
    val isRestoring: StateFlow<Boolean> = _isRestoring.asStateFlow()

    init {
        auth.addAuthStateListener { firebaseAuth ->
            _user.value = firebaseAuth.currentUser
            _isRestoring.value = false
        }
    }

    /**
     * Runs the sign-in sheet. Must be called with an **Activity** context —
     * Credential Manager needs something that can show UI, and passing the
     * application context here fails at runtime rather than compile time.
     */
    suspend fun signInWithGoogle(activityContext: Context, serverClientId: String): Result<Unit> {
        if (serverClientId.startsWith("PASTE_")) {
            return Result.failure(
                IllegalStateException(
                    "default_web_client_id is still a placeholder. Paste your " +
                        "Firebase web client ID into res/values/strings.xml."
                )
            )
        }

        return try {
            val option = GetSignInWithGoogleOption.Builder(serverClientId).build()
            val request = GetCredentialRequest.Builder().addCredentialOption(option).build()

            val response = credentialManager.getCredential(activityContext, request)
            val credential = response.credential

            if (credential !is CustomCredential ||
                credential.type != GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL
            ) {
                return Result.failure(IllegalStateException("Unexpected credential type."))
            }

            val googleCredential = GoogleIdTokenCredential.createFrom(credential.data)
            val firebaseCredential =
                GoogleAuthProvider.getCredential(googleCredential.idToken, null)

            auth.signInWithCredential(firebaseCredential).await()
            Result.success(Unit)
        } catch (cancelled: GetCredentialCancellationException) {
            // Backing out of the sheet isn't an error worth surfacing.
            Result.success(Unit)
        } catch (e: GetCredentialException) {
            Result.failure(e)
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    fun signOut() {
        auth.signOut()
    }
}
