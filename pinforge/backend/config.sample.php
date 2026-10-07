<?php
// Copy this file to config.php and fill in your values. NEVER commit config.php.
return [
    // Your Gemini API key (lives only on the server).
    'gemini_api_key' => 'PASTE_YOUR_GEMINI_KEY_HERE',

    // Long random string. Paste the same value into PinForge Settings > "Proxy access token".
    // Generate one with:  php -r "echo bin2hex(random_bytes(24));"
    'access_token' => 'CHANGE_ME_TO_A_LONG_RANDOM_STRING',

    // Your extension's ID from chrome://extensions (Developer mode shows it).
    'allowed_extension_ids' => ['your-extension-id-here'],

    // Only these models may be requested through the proxy.
    'allowed_models' => ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'],

    // Simple abuse limit per IP address.
    'max_requests_per_minute' => 30,

    // Optional MySQL logging (see schema.sql). Leave 'dsn' empty to disable.
    'db' => [
        'dsn'  => '', // e.g. 'mysql:host=localhost;dbname=pinforge;charset=utf8mb4'
        'user' => '',
        'pass' => '',
    ],
];
