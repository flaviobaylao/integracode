pluginManagement {
    repositories {
        google()
        // repo1.maven.org e o proprio Maven Central (mesmo conteudo, outro host):
        // o host repo.maven.apache.org vinha respondendo 429 no build.
        maven("https://repo1.maven.org/maven2")
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositories {
        google()
        maven("https://repo1.maven.org/maven2")
        mavenCentral()
    }
}
rootProject.name = "INTEGRA Balcao"
include(":app")
