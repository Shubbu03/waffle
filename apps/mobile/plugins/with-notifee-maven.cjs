const { CodeGenerator, withProjectBuildGradle } = require('expo/config-plugins')

// Expo's configuration-on-demand can resolve app dependencies before Notifee
// registers its bundled Maven repository. Register it in the root project.
module.exports = function withNotifeeMaven(config) {
  return withProjectBuildGradle(config, (config) => {
    config.modResults.contents = CodeGenerator.mergeContents({
      src: config.modResults.contents,
      tag: 'waffle-notifee-maven',
      anchor: /^allprojects\s*\{/m,
      offset: 0,
      comment: '//',
      newSrc: `def notifeePackageJson = new File(providers.exec {
  workingDir(rootDir)
  commandLine("node", "--print", "require.resolve('@notifee/react-native/package.json')")
}.standardOutput.asText.get().trim())

allprojects {
  repositories {
    maven {
      url new File(notifeePackageJson.parentFile, "android/libs")
      content { includeGroup("app.notifee") }
    }
  }
}`,
    }).contents
    return config
  })
}
