plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.google.services)
}

android {
    namespace = "com.umerzia.commanddeck"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.umerzia.commanddeck"
        minSdk = 26            // java.time without desugaring starts here
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        getByName("debug") {
            // A SHARED debug keystore, so your Mac and every CI runner sign
            // with the same key — and therefore present the same SHA-1 that
            // Firebase has on file for Google sign-in.
            //
            // Without this, each machine uses its own auto-generated
            // ~/.android/debug.keystore. CI runners are fresh VMs, so theirs
            // is different on every run and sign-in fails in CI-built APKs.
            //
            // Not committed: generated once, then injected from a secret.
            // See FIREBASE-SETUP.md section 8.
            val shared = rootProject.file("debug.keystore")
            if (shared.exists()) {
                storeFile = shared
                storePassword = "android"
                keyAlias = "androiddebugkey"
                keyPassword = "android"
            }
            // Falls through to Gradle's per-machine default when absent —
            // the app still builds, sign-in just won't work in that APK.
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("debug")
            // CI builds and distributes the debug variant: it's signed with
            // the auto-generated debug keystore, so no release signing
            // secrets are needed to get a working APK onto a phone.
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            // Left unsigned on purpose. Release signing needs a keystore,
            // which is a real secret — see CI-CD.md for how you'd add one.
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }

    testOptions {
        unitTests {
            // Lets unit tests read android.util.Log etc. without mocking.
            isReturnDefaultValues = true
        }
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons)
    debugImplementation(libs.androidx.compose.ui.tooling)

    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.auth)
    implementation(libs.firebase.firestore)

    implementation(libs.androidx.credentials)
    implementation(libs.androidx.credentials.play.services)
    implementation(libs.googleid)
    implementation(libs.kotlinx.coroutines.play.services)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}
