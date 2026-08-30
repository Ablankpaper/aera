/**
 * Build the opt-in Python wrapper used by the Beta.38 packaged Gateway
 * boundary diagnostic.
 *
 * The normal Desktop launch remains `python -m hermes_cli.main gateway`.  When
 * AGENTERA_E2E_GATEWAY_STARTUP_TRACE=1 is present, hermes.ts replaces that
 * command with `python -c <this wrapper>`.  The wrapper still dispatches the
 * exact same module and argv, but records the first startup function that
 * does not return and periodic Python stacks.  Paths and credentials stay in
 * the child environment; the trace itself contains only path-free metadata.
 */

const TARGET_FUNCTIONS = [
  "cmd_gateway",
  "gateway_command",
  "_gateway_command_inner",
  "run_gateway",
  "start_gateway",
  "record_boot_fingerprint",
  "record_start_and_check_storm",
  "_guard_existing_gateway_process_conflict",
  "_guard_named_profile_under_multiplexer",
  "_guard_supervised_gateway_conflict",
  "sync_skills",
  "_sync_bundled_skills_quietly",
  "_sync_bundled_skills_for_startup",
  "setup_logging",
  "GatewayRunner",
  "GatewayRunner.__init__",
  "get_running_pid",
  "_pid_exists",
  "acquire_gateway_runtime_lock",
  "is_gateway_runtime_lock_active",
  "write_pid_file",
  "_ensure_windows_gateway_venv_imports",
  "discover_mcp_tools",
] as const;

const TARGET_FILES = [
  "hermes_cli/main.py",
  "hermes_cli/gateway.py",
  "gateway/run.py",
  "gateway/status.py",
  "gateway/code_skew.py",
  "tools/skills_sync.py",
  "hermes_logging.py",
] as const;

function profileArguments(profile?: string): string[] {
  return profile === undefined ? [] : ["--profile", profile];
}

/**
 * Return a self-contained Python `-c` program.  Keep this function free of
 * runtime paths and secrets: all file locations are read from environment
 * variables inside the child process.
 */
export function buildGatewayStartupDiagnosticScript(profile?: string): string {
  const argv = [
    "aera-gateway-startup-diagnostic",
    ...profileArguments(profile),
    "gateway",
  ];
  return [
    "import faulthandler,json,os,runpy,sys,threading,time",
    `TARGETS=set(${JSON.stringify(TARGET_FUNCTIONS)})`,
    `TARGET_FILES=set(${JSON.stringify(TARGET_FILES)})`,
    "TRACE_PATH=os.environ.get('AERA_GATEWAY_STARTUP_TRACE_PATH')",
    "STACK_PATH=os.environ.get('AERA_GATEWAY_STARTUP_STACK_PATH')",
    "TRACE_FILE=None",
    "STACK_FILE=None",
    "WRITE_LOCK=threading.Lock()",
    "SEEN=set()",
    "EVENT_COUNT=0",
    "MAX_EVENTS=1024",
    "STARTED=time.monotonic()",
    "def _open_files():\n  global TRACE_FILE,STACK_FILE\n  try:\n    if TRACE_PATH: TRACE_FILE=open(TRACE_PATH,'a',encoding='utf-8',buffering=1)\n  except Exception: TRACE_FILE=None\n  try:\n    if STACK_PATH: STACK_FILE=open(STACK_PATH,'ab',buffering=0)\n  except Exception: STACK_FILE=None",
    "def _write(event,**extra):\n  global EVENT_COUNT\n  if TRACE_FILE is None or EVENT_COUNT >= MAX_EVENTS: return\n  try:\n    payload={'event':event,'elapsedMs':int((time.monotonic()-STARTED)*1000),**extra}\n    with WRITE_LOCK:\n      TRACE_FILE.write(json.dumps(payload,default=str,separators=(',',':'))+'\\n')\n      TRACE_FILE.flush()\n    EVENT_COUNT += 1\n  except Exception: pass",
    "def _file_allowed(filename):\n  normalized=filename.replace('\\\\','/').lower()\n  return any(normalized.endswith(part.lower()) for part in TARGET_FILES)",
    "def _profile(frame,event,arg):\n  if event not in ('call','return'): return _profile\n  try:\n    filename=frame.f_code.co_filename\n    short=frame.f_code.co_name\n    qualified=getattr(frame.f_code,'co_qualname',short)\n    if not _file_allowed(filename) or (short not in TARGETS and qualified not in TARGETS): return _profile\n    key=(event,filename,qualified,frame.f_lineno,threading.current_thread().name)\n    if key in SEEN or len(SEEN) >= MAX_EVENTS: return _profile\n    SEEN.add(key)\n    _write('function-'+('enter' if event == 'call' else 'return'),function=qualified,file=filename.replace('\\\\','/').rsplit('/',1)[-1],line=frame.f_lineno,thread=threading.current_thread().name)\n  except Exception: pass\n  return _profile",
    "def _console_mode(handle):\n  try:\n    import ctypes\n    mode=ctypes.c_uint32()\n    ok=ctypes.windll.kernel32.GetConsoleMode(handle,ctypes.byref(mode))\n    return bool(ok)\n  except Exception: return None",
    "def _windows_context():\n  if os.name != 'nt': return {}\n  result={}\n  try:\n    import ctypes\n    kernel32=ctypes.windll.kernel32\n    result['consoleWindow']=bool(kernel32.GetConsoleWindow())\n    result['stdinConsoleMode']=_console_mode(kernel32.GetStdHandle(-10))\n    result['stdoutConsoleMode']=_console_mode(kernel32.GetStdHandle(-11))\n    result['stderrConsoleMode']=_console_mode(kernel32.GetStdHandle(-12))\n    in_job=ctypes.c_int()\n    result['inJob']=bool(kernel32.IsProcessInJob(kernel32.GetCurrentProcess(),None,ctypes.byref(in_job)) and in_job.value)\n  except Exception as error:\n    result['windowsApiError']=type(error).__name__\n  return result",
    "def _process_context():\n  values={'pid':os.getpid(),'parentPid':getattr(os,'getppid',lambda:None)(),'stdinIsTty':None,'stdoutIsTty':None,'stderrIsTty':None,'pythonImage':os.path.basename(sys.executable),'detachedMarker':bool(os.environ.get('HERMES_GATEWAY_DETACHED'))}\n  for name,stream in (('stdinIsTty',sys.stdin),('stdoutIsTty',sys.stdout),('stderrIsTty',sys.stderr)):\n    try: values[name]=bool(stream.isatty())\n    except Exception: values[name]=None\n  values.update(_windows_context())\n  return values",
    "def _close_files():\n  for handle in (TRACE_FILE,STACK_FILE):\n    try:\n      if handle is not None: handle.close()\n    except Exception: pass",
    "_open_files()",
    "_write('wrapper-start',**_process_context())",
    "if STACK_FILE is not None:\n  try:\n    faulthandler.enable(file=STACK_FILE,all_threads=True)\n    faulthandler.dump_traceback_later(5.0,repeat=True,file=STACK_FILE)\n  except Exception as error:\n    _write('faulthandler-error',errorType=type(error).__name__)",
    "sys.setprofile(_profile)",
    "threading.setprofile(_profile)",
    `sys.argv=${JSON.stringify(argv)}`,
    "_write('dispatch-before',module='hermes_cli.main',argvCount=len(sys.argv))",
    "try:\n  runpy.run_module('hermes_cli.main',run_name='__main__')\nexcept BaseException as error:\n  _write('dispatch-exception',errorType=type(error).__name__)\n  raise\nfinally:\n  _write('dispatch-after')\n  try: faulthandler.cancel_dump_traceback_later()\n  except Exception: pass\n  _close_files()",
  ].join("\n");
}

export const GATEWAY_STARTUP_TRACE_ENV =
  "AGENTERA_E2E_GATEWAY_STARTUP_TRACE" as const;
