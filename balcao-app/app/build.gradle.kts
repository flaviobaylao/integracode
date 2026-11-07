plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "br.com.honest.integrabalcao"
    compileSdk = 34

    defaultConfig {
        applicationId = "br.com.honest.integrabalcao"
        minSdk = 24
        // NAO SUBIR PARA 31+ (ver LEIA-ME: a Cielo recusa a troca de esquema de assinatura).
        targetSdk = 29
        versionCode = 9
        versionName = "0.8.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    lint {
        // targetSdk 29 e decisao consciente (Cielo); o lint do Play nao manda aqui.
        disable += "ExpiredTargetSdkVersion"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions { jvmTarget = "1.8" }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    implementation("com.google.zxing:core:3.5.3")
}
