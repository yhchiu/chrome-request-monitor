# 🌐 Chrome Network Request Monitor Extension

A powerful Chrome extension that monitors network requests on web pages and finds specific URLs based on custom rules.

[繁體中文說明](README_zh-TW.md)

## ✨ Features

- 🔍 **Real-time Monitoring**: Automatically monitors all network requests on active tabs
- 📋 **Custom Rules**: Supports multiple matching patterns (contains, starts with, ends with, regex)
- 📌 **Page Overlay Display**: Shows notification boxes on pages when matching URLs are found
- 📊 **Unified Management**: View all found URLs in the popup window
- ⚙️ **Flexible Settings**: Easily manage matching rules through the options page
- 📋 **One-click Copy**: Quickly copy found URLs

## 🚀 Installation

### 1. Developer Mode Installation (Recommended)

1. Open Chrome browser
2. Navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right corner
4. Click "Load unpacked"
5. Select the folder containing the extension files
6. Extension installation complete!

### 2. File Structure

```
chrome_request_monitor/
├── manifest.json          # Extension configuration file
├── background.js          # Background service script
├── content.js            # Content script
├── popup.html            # Popup window page
├── popup.js              # Popup window script
├── options.html          # Options page
├── options.js            # Options page script
├── styles.css            # Style file
├── README.md             # Documentation (English)
└── README_zh-TW.md       # Documentation (Traditional Chinese)
```

## 📖 Usage Guide

### Step 1: Set Matching Rules

1. Click the extension icon in Chrome toolbar
2. Click the "Settings" button or right-click and select "Options"
3. Add URL matching rules on the options page:
   - **Rule Name**: Give the rule an easily identifiable name
   - **Match Type**: Select matching pattern
   - **Match Value**: Enter the content to match

### Step 2: Start Monitoring

After setting up rules, when you browse websites:
- URLs matching the rules will automatically display notification boxes in the top right corner of the page
- Click the "Copy" button in the notification box to copy the URL
- Click the "Close" button to dismiss the notification box

### Step 3: View History

- Click the extension icon to open the popup window
- View the list of all found URLs
- Click the "Copy URL" button to copy specific URLs
- Use the "Clear All" button to clear the history

## 🔧 Matching Rule Types

| Type | Description | Example |
|------|-------------|---------|
| **Contains** | URL contains specified text | `api.example.com` |
| **Starts With** | URL starts with specified text | `https://api.` |
| **Ends With** | URL ends with specified text | `.json` |
| **Regex** | Match using regular expressions | `/api/v\d+/users` |

## 💡 Usage Examples

### Example 1: Monitor API Requests
- **Rule Name**: `API Requests`
- **Match Type**: `Contains`
- **Match Value**: `/api/`

### Example 2: Monitor JSON Data
- **Rule Name**: `JSON Data`
- **Match Type**: `Ends With`
- **Match Value**: `.json`

### Example 3: Monitor Specific API Versions
- **Rule Name**: `API Version Monitor`
- **Match Type**: `Regex`
- **Match Value**: `/api/v[0-9]+/`

## 🛠️ Technical Specifications

- **Manifest Version**: V3
- **Supported Browsers**: Chrome 88+
- **Required Permissions**:
  - `activeTab`: Access active tabs
  - `storage`: Store user settings
  - `webRequest`: Monitor network requests
  - `scripting`: Inject content scripts

## 🔒 Privacy Notice

- This extension only processes data locally and does not upload any information to external servers
- User-defined rules are stored in Chrome sync storage
- Found URLs are only temporarily stored in memory and are not permanently saved

## 🤝 Contributing

Issue reports and feature suggestions are welcome!

## 📄 License

This project is licensed under the GPL-3.0 License.

---

**Enjoy using the Network Request Monitor!** 🎉 