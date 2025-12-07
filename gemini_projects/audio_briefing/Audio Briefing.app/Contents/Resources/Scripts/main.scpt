on run
    try
        -- Initial greeting
        say "Good morning. Here is your audio briefing."

        -- Play bundled audio file
        set resourceFolder to path to resource folder
        set posixResourceFolder to POSIX path of resourceFolder
        set audioPath to posixResourceFolder & "briefing_audio.mp3"
        set posixAudioPath to quoted form of audioPath
        do shell script "afplay " & posixAudioPath

        -- Concluding remark
        say "That concludes your briefing. Have a great day."

    on error errMsg number errNum
        log "Error: " & errMsg & " (Error Code: " & errNum & ")"
    end try
end run
