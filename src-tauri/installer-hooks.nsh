; Extra installer steps for TTCO Plus.
;
; When the install folder is writable (e.g. a per-user install), the app keeps
; its settings in "<install folder>\data" so everything stays in one place.
; The standard uninstaller only removes the app's files from there, so if the
; user ticks "Delete the application data" we remove that folder too.

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
    RMDir /r "$INSTDIR\data"
    RMDir "$INSTDIR"
  ${EndIf}
!macroend
