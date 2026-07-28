using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using System.Drawing;

internal sealed class HeartbeatConfig
{
    public string Url = "https://jorycen.fun/api/v1/health/db";
    public int IntervalSeconds = 300;
    public int TimeoutMilliseconds = 30000;
    public int RetryCount = 3;
    public int RetryDelaySeconds = 5;
    public string LogFile = "heartbeat.log";

    public static HeartbeatConfig Load(string path)
    {
        var config = new HeartbeatConfig();
        if (!File.Exists(path))
        {
            return config;
        }

        foreach (var rawLine in File.ReadAllLines(path, Encoding.UTF8))
        {
            var line = rawLine.Trim();
            if (line.Length == 0 || line.StartsWith("#") || line.StartsWith(";"))
            {
                continue;
            }

            var separator = line.IndexOf('=');
            if (separator <= 0)
            {
                continue;
            }

            var key = line.Substring(0, separator).Trim().ToLowerInvariant();
            var value = line.Substring(separator + 1).Trim();
            switch (key)
            {
                case "url":
                    config.Url = value;
                    break;
                case "intervalseconds":
                    config.IntervalSeconds = ParsePositiveInt(value, config.IntervalSeconds);
                    break;
                case "timeoutmilliseconds":
                    config.TimeoutMilliseconds = ParsePositiveInt(value, config.TimeoutMilliseconds);
                    break;
                case "retrycount":
                    config.RetryCount = ParseNonNegativeInt(value, config.RetryCount);
                    break;
                case "retrydelayseconds":
                    config.RetryDelaySeconds = ParseNonNegativeInt(value, config.RetryDelaySeconds);
                    break;
                case "logfile":
                    config.LogFile = value;
                    break;
            }
        }

        return config;
    }

    public void Save(string path)
    {
        var lines = new[]
        {
            "# ANY-ERP API heartbeat client configuration",
            "URL=" + Url,
            "IntervalSeconds=" + IntervalSeconds,
            "TimeoutMilliseconds=" + TimeoutMilliseconds,
            "RetryCount=" + RetryCount,
            "RetryDelaySeconds=" + RetryDelaySeconds,
            "LogFile=" + LogFile
        };
        File.WriteAllLines(path, lines, Encoding.UTF8);
    }

    private static int ParsePositiveInt(string value, int fallback)
    {
        int result;
        return Int32.TryParse(value, out result) && result > 0 ? result : fallback;
    }

    private static int ParseNonNegativeInt(string value, int fallback)
    {
        int result;
        return Int32.TryParse(value, out result) && result >= 0 ? result : fallback;
    }
}

internal sealed class HeartbeatResult
{
    public bool Success;
    public int StatusCode;
    public long ElapsedMilliseconds;
    public string Message;
}

internal sealed class HeartbeatClient
{
    private readonly HeartbeatConfig _config;
    private readonly string _logPath;
    private readonly object _logLock = new object();

    public HeartbeatClient(HeartbeatConfig config, string baseDirectory)
    {
        _config = config;
        _logPath = ResolveLogPath(config.LogFile, baseDirectory);
    }

    public HeartbeatResult Execute()
    {
        HeartbeatResult lastResult = null;
        for (var attempt = 1; attempt <= _config.RetryCount + 1; attempt++)
        {
            var stopwatch = Stopwatch.StartNew();
            try
            {
                lastResult = SendRequest(stopwatch);
                if (lastResult.Success)
                {
                    Log("SUCCESS " + lastResult.Message);
                    return lastResult;
                }
            }
            catch (WebException error)
            {
                lastResult = BuildWebExceptionResult(error, stopwatch.ElapsedMilliseconds);
            }
            catch (Exception error)
            {
                lastResult = new HeartbeatResult
                {
                    Success = false,
                    StatusCode = 0,
                    ElapsedMilliseconds = stopwatch.ElapsedMilliseconds,
                    Message = error.Message
                };
            }

            Log("FAIL attempt=" + attempt + " " + lastResult.Message);
            if (attempt <= _config.RetryCount && _config.RetryDelaySeconds > 0)
            {
                Thread.Sleep(TimeSpan.FromSeconds(_config.RetryDelaySeconds));
            }
        }

        return lastResult;
    }

    public void Log(string message)
    {
        var line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + message;
        lock (_logLock)
        {
            try
            {
                var directory = Path.GetDirectoryName(_logPath);
                if (!String.IsNullOrEmpty(directory))
                {
                    Directory.CreateDirectory(directory);
                }
                File.AppendAllText(_logPath, line + Environment.NewLine, Encoding.UTF8);
            }
            catch
            {
                // The result is still visible in the UI even when the log file is not writable.
            }
        }
    }

    private HeartbeatResult SendRequest(Stopwatch stopwatch)
    {
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;

        var request = (HttpWebRequest)WebRequest.Create(_config.Url);
        request.Method = "GET";
        request.Timeout = _config.TimeoutMilliseconds;
        request.ReadWriteTimeout = _config.TimeoutMilliseconds;
        request.KeepAlive = false;
        request.UserAgent = "ANY-ERP-Heartbeat/1.0";
        request.AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate;

        using (var response = (HttpWebResponse)request.GetResponse())
        {
            return ReadResponse(response, stopwatch.ElapsedMilliseconds);
        }
    }

    private static HeartbeatResult BuildWebExceptionResult(WebException error, long elapsedMilliseconds)
    {
        var response = error.Response as HttpWebResponse;
        if (response != null)
        {
            using (response)
            {
                return ReadResponse(response, elapsedMilliseconds);
            }
        }

        return new HeartbeatResult
        {
            Success = false,
            StatusCode = 0,
            ElapsedMilliseconds = elapsedMilliseconds,
            Message = error.Message
        };
    }

    private static HeartbeatResult ReadResponse(HttpWebResponse response, long elapsedMilliseconds)
    {
        var body = String.Empty;
        using (var stream = response.GetResponseStream())
        using (var reader = new StreamReader(stream ?? Stream.Null, Encoding.UTF8))
        {
            body = ReadAtMost(reader, 512);
        }

        var statusCode = (int)response.StatusCode;
        return new HeartbeatResult
        {
            Success = statusCode >= 200 && statusCode < 300,
            StatusCode = statusCode,
            ElapsedMilliseconds = elapsedMilliseconds,
            Message = "status=" + statusCode + " elapsed=" + elapsedMilliseconds + "ms body=" + Compact(body)
        };
    }

    private static string ReadAtMost(TextReader reader, int maxCharacters)
    {
        var buffer = new char[256];
        var builder = new StringBuilder();
        while (builder.Length < maxCharacters)
        {
            var count = reader.Read(buffer, 0, Math.Min(buffer.Length, maxCharacters - builder.Length));
            if (count <= 0)
            {
                break;
            }
            builder.Append(buffer, 0, count);
        }
        return builder.ToString();
    }

    private static string Compact(string value)
    {
        return (value ?? String.Empty).Replace("\r", " ").Replace("\n", " ").Trim();
    }

    private static string ResolveLogPath(string configuredPath, string baseDirectory)
    {
        if (String.IsNullOrWhiteSpace(configuredPath))
        {
            configuredPath = "heartbeat.log";
        }
        return Path.IsPathRooted(configuredPath) ? configuredPath : Path.Combine(baseDirectory, configuredPath);
    }
}

internal sealed class HeartbeatForm : Form
{
    private readonly string _baseDirectory;
    private readonly string _configPath;
    private HeartbeatConfig _config;
    private HeartbeatClient _client;
    private System.Windows.Forms.Timer _timer;
    private TextBox _urlTextBox;
    private NumericUpDown _intervalInput;
    private NumericUpDown _timeoutInput;
    private Button _startButton;
    private Button _stopButton;
    private Button _saveButton;
    private Label _stateLabel;
    private Label _nextRunLabel;
    private ListView _historyList;
    private bool _running;
    private int _requestInProgress;
    private DateTime _nextRunAt;

    public HeartbeatForm()
    {
        _baseDirectory = AppDomain.CurrentDomain.BaseDirectory;
        _configPath = Path.Combine(_baseDirectory, "heartbeat.config");
        _config = HeartbeatConfig.Load(_configPath);
        BuildWindow();
    }

    private void BuildWindow()
    {
        Text = "ANY-ERP API 心跳保活";
        Width = 980;
        Height = 620;
        MinimumSize = new Size(800, 500);
        StartPosition = FormStartPosition.CenterScreen;

        var settings = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            Height = 125,
            Padding = new Padding(12),
            ColumnCount = 4,
            RowCount = 3
        };
        settings.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 90));
        settings.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        settings.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 90));
        settings.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 190));

        settings.Controls.Add(new Label { Text = "API 地址", AutoSize = true, Anchor = AnchorStyles.Left }, 0, 0);
        _urlTextBox = new TextBox { Text = _config.Url, Dock = DockStyle.Fill };
        settings.Controls.Add(_urlTextBox, 1, 0);
        settings.SetColumnSpan(_urlTextBox, 3);

        settings.Controls.Add(new Label { Text = "执行间隔", AutoSize = true, Anchor = AnchorStyles.Left }, 0, 1);
        _intervalInput = CreateNumberInput(1, 86400, _config.IntervalSeconds);
        settings.Controls.Add(_intervalInput, 1, 1);
        settings.Controls.Add(new Label { Text = "秒（默认 300）", AutoSize = true, Anchor = AnchorStyles.Left }, 2, 1);
        settings.Controls.Add(new Label { Text = "请求超时", AutoSize = true, Anchor = AnchorStyles.Left }, 0, 2);
        _timeoutInput = CreateNumberInput(1000, 300000, _config.TimeoutMilliseconds);
        settings.Controls.Add(_timeoutInput, 1, 2);
        settings.Controls.Add(new Label { Text = "毫秒", AutoSize = true, Anchor = AnchorStyles.Left }, 2, 2);

        var buttonPanel = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true };
        _startButton = new Button { Text = "开始心跳", Width = 100, Height = 30 };
        _stopButton = new Button { Text = "停止心跳", Width = 100, Height = 30, Enabled = false };
        _saveButton = new Button { Text = "保存配置", Width = 100, Height = 30 };
        _startButton.Click += StartButtonClick;
        _stopButton.Click += StopButtonClick;
        _saveButton.Click += SaveButtonClick;
        buttonPanel.Controls.Add(_startButton);
        buttonPanel.Controls.Add(_stopButton);
        buttonPanel.Controls.Add(_saveButton);
        settings.Controls.Add(buttonPanel, 3, 1);
        settings.SetRowSpan(buttonPanel, 2);

        var statusPanel = new FlowLayoutPanel
        {
            Dock = DockStyle.Top,
            Height = 48,
            Padding = new Padding(12, 4, 12, 4),
            WrapContents = false
        };
        _stateLabel = new Label { Text = "状态：未运行", AutoSize = true, Margin = new Padding(0, 6, 24, 0) };
        _nextRunLabel = new Label { Text = "下一次执行：-", AutoSize = true, Margin = new Padding(0, 6, 0, 0) };
        statusPanel.Controls.Add(_stateLabel);
        statusPanel.Controls.Add(_nextRunLabel);

        _historyList = new ListView
        {
            Dock = DockStyle.Fill,
            View = View.Details,
            FullRowSelect = true,
            GridLines = true,
            HideSelection = false
        };
        _historyList.Columns.Add("执行时间", 150);
        _historyList.Columns.Add("结果", 70);
        _historyList.Columns.Add("HTTP", 60);
        _historyList.Columns.Add("耗时", 80);
        _historyList.Columns.Add("返回信息", 560);

        Controls.Add(_historyList);
        Controls.Add(statusPanel);
        Controls.Add(settings);

        _timer = new System.Windows.Forms.Timer();
        _timer.Tick += TimerTick;
        FormClosing += FormClosingHandler;
        Shown += delegate(object sender, EventArgs e)
        {
            BeginInvoke((MethodInvoker)delegate { StartHeartbeat(); });
        };
    }

    private static NumericUpDown CreateNumberInput(int minimum, int maximum, int value)
    {
        return new NumericUpDown
        {
            Minimum = minimum,
            Maximum = maximum,
            Value = Math.Max(minimum, Math.Min(maximum, value)),
            Width = 110,
            Anchor = AnchorStyles.Left
        };
    }

    private void StartButtonClick(object sender, EventArgs e)
    {
        StartHeartbeat();
    }

    private void StartHeartbeat()
    {
        if (_running)
        {
            return;
        }

        Uri endpoint;
        if (!Uri.TryCreate(_urlTextBox.Text.Trim(), UriKind.Absolute, out endpoint)
            || (endpoint.Scheme != Uri.UriSchemeHttp && endpoint.Scheme != Uri.UriSchemeHttps))
        {
            MessageBox.Show(this, "请输入有效的 HTTP/HTTPS API 地址。", "地址错误", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        _config.Url = endpoint.ToString();
        _config.IntervalSeconds = Decimal.ToInt32(_intervalInput.Value);
        _config.TimeoutMilliseconds = Decimal.ToInt32(_timeoutInput.Value);
        _client = new HeartbeatClient(_config, _baseDirectory);
        _timer.Interval = Math.Max(1000, _config.IntervalSeconds * 1000);
        _running = true;
        _startButton.Enabled = false;
        _stopButton.Enabled = true;
        _stateLabel.Text = "状态：运行中，正在执行首次查询...";
        _client.Log("START url=" + _config.Url + " interval=" + _config.IntervalSeconds + "s");
        RunHeartbeat();
        _timer.Start();
    }

    private void StopButtonClick(object sender, EventArgs e)
    {
        StopHeartbeat();
    }

    private void SaveButtonClick(object sender, EventArgs e)
    {
        _config.Url = _urlTextBox.Text.Trim();
        _config.IntervalSeconds = Decimal.ToInt32(_intervalInput.Value);
        _config.TimeoutMilliseconds = Decimal.ToInt32(_timeoutInput.Value);
        try
        {
            _config.Save(_configPath);
            MessageBox.Show(this, "配置已保存。", "保存成功", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception error)
        {
            MessageBox.Show(this, error.Message, "保存失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void TimerTick(object sender, EventArgs e)
    {
        RunHeartbeat();
    }

    private void RunHeartbeat()
    {
        if (!_running || _client == null || Interlocked.Exchange(ref _requestInProgress, 1) == 1)
        {
            return;
        }

        _nextRunAt = DateTime.Now.AddSeconds(_config.IntervalSeconds);
        _nextRunLabel.Text = "下一次执行：" + _nextRunAt.ToString("yyyy-MM-dd HH:mm:ss");
        _stateLabel.Text = "状态：运行中，正在查询...";
        ThreadPool.QueueUserWorkItem(delegate(object state)
        {
            HeartbeatResult result;
            try
            {
                result = _client.Execute();
            }
            catch (Exception error)
            {
                result = new HeartbeatResult { Success = false, Message = error.Message };
            }

            try
            {
                BeginInvoke((MethodInvoker)delegate
                {
                    Interlocked.Exchange(ref _requestInProgress, 0);
                    AddHistory(result);
                    _stateLabel.Text = result.Success ? "状态：运行中，最近一次成功" : "状态：运行中，最近一次失败";
                });
            }
            catch (InvalidOperationException)
            {
                Interlocked.Exchange(ref _requestInProgress, 0);
            }
        });
    }

    private void AddHistory(HeartbeatResult result)
    {
        var item = new ListViewItem(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
        item.SubItems.Add(result.Success ? "成功" : "失败");
        item.SubItems.Add(result.StatusCode == 0 ? "-" : result.StatusCode.ToString());
        item.SubItems.Add(result.ElapsedMilliseconds + " ms");
        item.SubItems.Add(result.Message ?? String.Empty);
        _historyList.Items.Insert(0, item);
        while (_historyList.Items.Count > 100)
        {
            _historyList.Items.RemoveAt(_historyList.Items.Count - 1);
        }
    }

    private void StopHeartbeat()
    {
        _running = false;
        _timer.Stop();
        _startButton.Enabled = true;
        _stopButton.Enabled = false;
        _stateLabel.Text = "状态：已停止";
        _nextRunLabel.Text = "下一次执行：-";
        if (_client != null)
        {
            _client.Log("STOP");
        }
    }

    private void FormClosingHandler(object sender, FormClosingEventArgs e)
    {
        StopHeartbeat();
    }
}

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new HeartbeatForm());
    }
}
