param(
    [string]$LB_ComfyUrl = "http://127.0.0.1:8188",
    [int]$LB_Port = 8000
)

$env:LB_COMFY_URL = $LB_ComfyUrl
Set-Location (Join-Path $PSScriptRoot "backend")
& .\.venv\Scripts\python.exe -m uvicorn libretto.main:app_factory --factory --host 127.0.0.1 --port $LB_Port
