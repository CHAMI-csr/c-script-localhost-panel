!macro customUnInstall
  # Never offer to remove user data during an upgrade or a silent updater run.
  ${ifNot} ${isUpdated}
    ${ifNot} ${Silent}
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also permanently remove the downloaded PHP, MySQL / MariaDB, and NGINX runtimes, local database files, and C-Script settings?$\r$\n$\r$\nThis cannot be undone. Choose No to keep them for a later reinstall." IDNO keepUserData

      RMDir /r "$APPDATA\c-script-localhost"
      RMDir /r "$APPDATA\antigravity-localhost"
      RMDir /r "$PROFILE\.c-script"

      IfFileExists "$APPDATA\c-script-localhost\*.*" cleanupIncomplete 0
      IfFileExists "$APPDATA\antigravity-localhost\*.*" cleanupIncomplete 0
      IfFileExists "$PROFILE\.c-script\*.*" cleanupIncomplete 0
      Goto keepUserData

      cleanupIncomplete:
        MessageBox MB_OK|MB_ICONEXCLAMATION "Some C-Script data could not be removed, possibly because a local server is still running. Stop the server and remove these folders manually if you no longer need them: $\r$\n$APPDATA\c-script-localhost$\r$\n$PROFILE\.c-script"

      keepUserData:
    ${endIf}
  ${endIf}
!macroend
