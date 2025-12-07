on run
    try
        -- Initial greeting
        say "Good morning. Here is your audio briefing."

        -- Get path to current script
        set scriptPath to path to me

        -- Extract the path to the Resources folder
        -- This involves navigating up the bundle structure
        set appBundlePath to container of container of container of scriptPath
        set resourcesPath to (appBundlePath as string) & "Contents:Resources:"
        set posixResourceFolder to POSIX path of resourcesPath
        
        -- Play bundled audio file
        set audioPath to posixResourceFolder & "briefing_audio.mp3"
        set posixAudioPath to quoted form of audioPath
        do shell script "afplay " & posixAudioPath

        -- Concluding remark
        say "That concludes your briefing. Have a great day."

    on error errMsg number errNum
        log "Error: " & errMsg & " (Error Code: " & errNum & ")"
    end try
end run
