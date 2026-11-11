"""RAME Code: run one terminal command under Linux Landlock (shellIsolation.ts).

usage:
  python3 -I rame-isolate.py --probe
  python3 -I rame-isolate.py [--no-net] --write DIR [--write DIR ...] -- command args...
  python3 -I rame-isolate.py --protect-reads --read-file FILE [--read-tree DIR ...]
      [--read-dir DIR ...] [--write DIR ...] [--no-net] -- command args...

- writes: only inside the --write folders (plus /dev/null, /dev/tty, /dev/zero, /dev/urandom);
- reads and runs programs: everywhere (secrets readable by the user stay readable);
- --protect-reads: deny every read except system runtimes and the exact files/
  trees named by --read-file/--read-tree. --read-dir permits directory listing
  and traversal, but not reading the files beneath it;
- --no-net: no TCP connect or bind (Landlock ABI >= 4). In protected-read
  verifier mode libseccomp also denies every socket family, including UDP and
  Unix sockets, plus cross-process inspection syscalls.
Applied to this process with no_new_privs (sudo and setuid programs cannot gain rights), then exec:
the command and all its children inherit it, and nothing they run can widen it again.
On any failure it exits 125 with a line starting "rame-isolate:" and runs nothing.
"""
import ctypes
import errno
import os
import sys

SYS_CREATE, SYS_ADD, SYS_RESTRICT = 444, 445, 446
PR_SET_NO_NEW_PRIVS = 38
RULE_PATH_BENEATH = 1
FS_NAMES = ['EXECUTE', 'WRITE_FILE', 'READ_FILE', 'READ_DIR', 'REMOVE_DIR', 'REMOVE_FILE', 'MAKE_CHAR', 'MAKE_DIR',
            'MAKE_REG', 'MAKE_SOCK', 'MAKE_FIFO', 'MAKE_BLOCK', 'MAKE_SYM', 'REFER', 'TRUNCATE', 'IOCTL_DEV']
FS = {name: 1 << bit for bit, name in enumerate(FS_NAMES)}
NET_BIND_TCP, NET_CONNECT_TCP = 1, 2


def fail(message):
    sys.stderr.write(f'rame-isolate: {message}\n')
    sys.stderr.flush()
    os._exit(125)


class RulesetAttr(ctypes.Structure):
    _fields_ = [('handled_access_fs', ctypes.c_uint64), ('handled_access_net', ctypes.c_uint64)]


class PathBeneath(ctypes.Structure):
    # struct landlock_path_beneath_attr is __attribute__((packed)): 12 bytes.
    # Python 3.14 warns on stderr unless the layout of a packed structure is
    # explicit; 'ms' is the layout ctypes always used here, and for these two
    # plain fields it equals GCC's packed layout. Older Pythons ignore it.
    _layout_ = 'ms'
    _pack_ = 1
    _fields_ = [('allowed_access', ctypes.c_uint64), ('parent_fd', ctypes.c_int32)]


def landlock_abi(libc):
    if not sys.platform.startswith('linux'):
        return 0
    abi = libc.syscall(SYS_CREATE, None, ctypes.c_size_t(0), ctypes.c_uint32(1))
    return abi if abi > 0 else 0


def has_seccomp():
    try:
        ctypes.CDLL('libseccomp.so.2', use_errno=True)
        return True
    except OSError:
        return False


def close_all_sockets_and_introspection():
    """Deny non-TCP exfiltration and cross-process inspection."""
    try:
        seccomp = ctypes.CDLL('libseccomp.so.2', use_errno=True)
    except OSError:
        fail('libseccomp is required for protected verification')
    seccomp.seccomp_init.argtypes = [ctypes.c_uint32]
    seccomp.seccomp_init.restype = ctypes.c_void_p
    seccomp.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    seccomp.seccomp_syscall_resolve_name.restype = ctypes.c_int
    seccomp.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    seccomp.seccomp_load.argtypes = [ctypes.c_void_p]
    seccomp.seccomp_release.argtypes = [ctypes.c_void_p]
    context = seccomp.seccomp_init(0x7fff0000)  # SCMP_ACT_ALLOW
    if not context:
        fail('seccomp_init failed for protected verification')
    try:
        deny = 0x00050000 | errno.EPERM  # SCMP_ACT_ERRNO(EPERM)
        names = ['socket', 'socketpair', 'connect', 'bind', 'listen', 'accept', 'accept4',
                 'sendto', 'sendmsg', 'sendmmsg', 'recvfrom', 'recvmsg', 'recvmmsg', 'shutdown',
                 'ptrace', 'process_vm_readv', 'process_vm_writev', 'bpf', 'perf_event_open']
        for name in names:
            number = seccomp.seccomp_syscall_resolve_name(name.encode())
            if number >= 0 and seccomp.seccomp_rule_add(context, deny, number, 0) != 0:
                fail(f'seccomp could not deny {name}')
        if seccomp.seccomp_load(context) != 0:
            fail('seccomp_load failed for protected verification')
    finally:
        seccomp.seccomp_release(context)


def main(argv):
    try:
        libc = ctypes.CDLL(None, use_errno=True)
    except OSError:
        fail('the C library could not be loaded')
    abi = landlock_abi(libc)
    if argv == ['--probe']:
        print(f'landlock-abi={abi} seccomp={1 if has_seccomp() else 0}')
        return
    if '--' not in argv:
        fail('missing -- before the command')
    split = argv.index('--')
    options, command = argv[:split], argv[split + 1:]
    writes, read_files, read_trees, read_dirs, no_net, protect_reads = [], [], [], [], False, False
    i = 0
    while i < len(options):
        if options[i] == '--write' and i + 1 < len(options):
            writes.append(options[i + 1])
            i += 2
        elif options[i] == '--read-file' and i + 1 < len(options):
            read_files.append(options[i + 1])
            i += 2
        elif options[i] == '--read-tree' and i + 1 < len(options):
            read_trees.append(options[i + 1])
            i += 2
        elif options[i] == '--read-dir' and i + 1 < len(options):
            read_dirs.append(options[i + 1])
            i += 2
        elif options[i] == '--protect-reads':
            protect_reads = True
            i += 1
        elif options[i] == '--no-net':
            no_net = True
            i += 1
        else:
            fail(f'unknown option {options[i]}')
    if not command or (not protect_reads and not writes):
        fail('a command and either --protect-reads or at least one --write folder are needed')
    if abi < 1:
        fail('Landlock is not available on this system, so the command was not run')
    if no_net and abi < 4:
        fail(f'Landlock ABI {abi} cannot block the network, so the command was not run')
    known = FS_NAMES[:13] + (['REFER'] if abi >= 2 else []) + (['TRUNCATE'] if abi >= 3 else []) + (['IOCTL_DEV'] if abi >= 5 else [])
    handled = sum(FS[name] for name in known)
    attr = RulesetAttr(handled, NET_BIND_TCP | NET_CONNECT_TCP if no_net else 0)
    size = ctypes.sizeof(attr) if abi >= 4 else 8
    ruleset = libc.syscall(SYS_CREATE, ctypes.byref(attr), ctypes.c_size_t(size), ctypes.c_uint32(0))
    if ruleset < 0:
        fail(f'landlock_create_ruleset failed (errno {ctypes.get_errno()})')
    file_rights = FS['EXECUTE'] | FS['READ_FILE'] | FS['WRITE_FILE'] | FS['TRUNCATE'] | FS['IOCTL_DEV']

    def allow(path, rights, required):
        try:
            fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
        except OSError:
            if required:
                fail(f'cannot open {path}')
            return
        try:
            granted = (rights if os.path.isdir(path) else rights & file_rights) & handled
            beneath = PathBeneath(granted, fd)
            if libc.syscall(SYS_ADD, ruleset, ctypes.c_int(RULE_PATH_BENEATH), ctypes.byref(beneath), ctypes.c_uint32(0)) != 0:
                fail(f'landlock_add_rule failed for {path} (errno {ctypes.get_errno()})')
        finally:
            os.close(fd)

    reads = FS['EXECUTE'] | FS['READ_FILE'] | FS['READ_DIR']
    writes_only = sum(FS[name] for name in ['WRITE_FILE', 'REMOVE_DIR', 'REMOVE_FILE', 'MAKE_CHAR', 'MAKE_DIR', 'MAKE_REG', 'MAKE_SOCK', 'MAKE_FIFO', 'MAKE_BLOCK', 'MAKE_SYM', 'REFER', 'TRUNCATE'] if name in known)
    if protect_reads:
        # The interpreter has already loaded this launcher. The command may
        # read/execute system runtimes, but no home, workspace, state or temp
        # tree is ambiently readable.
        for system in ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc/ssl']:
            allow(system, reads, False)
        for system_file in ['/etc/ld.so.cache', '/etc/ld.so.conf', '/etc/localtime', '/etc/nsswitch.conf', '/etc/passwd', '/etc/group', '/etc/hosts', '/etc/resolv.conf']:
            allow(system_file, FS['READ_FILE'], False)
        for path in read_dirs:
            allow(path, FS['READ_DIR'], True)
        for path in read_trees:
            allow(path, reads, True)
        for path in read_files:
            allow(path, FS['EXECUTE'] | FS['READ_FILE'], True)
        for path in writes:
            allow(path, writes_only, True)
    else:
        allow('/', reads, True)
        for index, path in enumerate(writes):
            # The first folder (the project) must exist; caches that do not exist are skipped.
            allow(path, handled, index == 0)
    for path in ['/dev/null', '/dev/tty', '/dev/zero', '/dev/urandom']:
        allow(path, FS['READ_FILE'] | FS['WRITE_FILE'] | FS['IOCTL_DEV'], False)
    if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        fail('prctl(no_new_privs) failed')
    if protect_reads:
        close_all_sockets_and_introspection()
    if libc.syscall(SYS_RESTRICT, ruleset, ctypes.c_uint32(0)) != 0:
        fail(f'landlock_restrict_self failed (errno {ctypes.get_errno()})')
    os.close(ruleset)
    if protect_reads:
        # Do not leak the extension host's credentials or unrelated state to
        # evaluated code. These variables describe only this verifier run.
        keep = {'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP', 'NODE_PATH', 'NODE_OPTIONS',
                'ELECTRON_RUN_AS_NODE', 'RAME_TRACE_FILE', 'RAME_TRACE_ROOT', 'RAME_TRACE_PARENT',
                'RAME_RESULTS_FILE', 'RAME_METRIC_REPEAT', 'RAME_METRIC_REPEATS', 'RAME_JOB'}
        environment = {key: value for key, value in os.environ.items() if key in keep}
        os.environ.clear()
        os.environ.update(environment)
    try:
        os.execvp(command[0], command)
    except OSError as error:
        fail(f'cannot run {command[0]}: {error.strerror}')


if __name__ == '__main__':
    main(sys.argv[1:])
