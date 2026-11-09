!include FileFunc.nsh

; The one-click uninstaller switches itself to silent mode, so ${Silent} is always true here.
; Check the command line for an explicit /S instead.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${GetParameters} $R0
    ${GetOptions} $R0 "/S" $R1
    ${if} ${Errors}
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your Libretto data (libraries, scenes, results and settings) in $APPDATA\Libretto?" IDNO libretto_keep_data
        RMDir /r "$APPDATA\Libretto"
      libretto_keep_data:
    ${endIf}
  ${endIf}
!macroend
