const { CodeGenerator, withAppBuildGradle } = require('expo/config-plugins')

// Local Gradle builds use the same version settings as Expo prebuild.
module.exports = function withAppVersion(config) {
  return withAppBuildGradle(config, (config) => {
    const contents = CodeGenerator.mergeContents({
      src: config.modResults.contents,
      tag: 'waffle-app-version',
      anchor: /^android\s*\{/m,
      offset: 0,
      comment: '//',
      newSrc:
        'def waffleAppConfig = new groovy.json.JsonSlurper().parse(new File(rootDir.parentFile, "app.json")).expo',
    }).contents
    config.modResults.contents = contents
      .replace(/^(\s*)versionCode\s+.+$/m, '$1versionCode waffleAppConfig.android.versionCode')
      .replace(/^(\s*)versionName\s+.+$/m, '$1versionName waffleAppConfig.version')
    return config
  })
}
