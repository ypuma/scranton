#![allow(
    non_snake_case,
    non_upper_case_globals,
    dead_code,
    unused_imports,
    unused_variables
)]

use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::io::{Read, Write};

#[repr(C)]
struct BY_HANDLE_FILE_INFORMATION {
    attributes: u32,
    creation_time: [u32; 2],
    access_time: [u32; 2],
    write_time: [u32; 2],
    volume: u32,
    size_high: u32,
    size_low: u32,
    nNumberOfLinks: u32,
    index_high: u32,
    index_low: u32,
}

#[repr(C)]
pub struct SECURITY_ATTRIBUTES {
    pub nLength: u32,
    pub lpSecurityDescriptor: *mut c_void,
    pub bInheritHandle: i32,
}

#[repr(C)]
pub struct SID_AND_ATTRIBUTES {
    pub Sid: *mut c_void,
    pub Attributes: u32,
}

#[repr(C)]
pub struct SECURITY_CAPABILITIES {
    pub AppContainerSid: *mut c_void,
    pub Capabilities: *mut SID_AND_ATTRIBUTES,
    pub CapabilityCount: u32,
    pub Reserved: u32,
}

#[repr(C)]
pub struct STARTUPINFOW {
    pub cb: u32,
    pub lpReserved: *mut u16,
    pub lpDesktop: *mut u16,
    pub lpTitle: *mut u16,
    pub dwX: u32,
    pub dwY: u32,
    pub dwXSize: u32,
    pub dwYSize: u32,
    pub dwXCountChars: u32,
    pub dwYCountChars: u32,
    pub dwFillAttribute: u32,
    pub dwFlags: u32,
    pub wShowWindow: u16,
    pub cbReserved2: u16,
    pub lpReserved2: *mut u8,
    pub hStdInput: *mut c_void,
    pub hStdOutput: *mut c_void,
    pub hStdError: *mut c_void,
}

#[repr(C)]
pub struct STARTUPINFOEXW {
    pub StartupInfo: STARTUPINFOW,
    pub lpAttributeList: *mut c_void,
}

#[repr(C)]
pub struct PROCESS_INFORMATION {
    pub hProcess: *mut c_void,
    pub hThread: *mut c_void,
    pub dwProcessId: u32,
    pub dwThreadId: u32,
}

#[repr(C)]
pub struct IO_COUNTERS {
    pub ReadOperationCount: u64,
    pub WriteOperationCount: u64,
    pub OtherOperationCount: u64,
    pub ReadTransferCount: u64,
    pub WriteTransferCount: u64,
    pub OtherTransferCount: u64,
}

#[repr(C)]
pub struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    pub PerProcessUserTimeLimit: i64,
    pub PerJobUserTimeLimit: i64,
    pub LimitFlags: u32,
    pub MinimumWorkingSetSize: usize,
    pub MaximumWorkingSetSize: usize,
    pub ActiveProcessLimit: u32,
    pub Affinity: usize,
    pub PriorityClass: u32,
    pub SchedulingClass: u32,
}

#[repr(C)]
pub struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    pub BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION,
    pub IoInfo: IO_COUNTERS,
    pub ProcessMemoryLimit: usize,
    pub JobMemoryLimit: usize,
    pub PeakProcessMemoryUsed: usize,
    pub PeakJobMemoryUsed: usize,
}

#[repr(C)]
pub struct TOKEN_MANDATORY_LABEL {
    pub Label: SID_AND_ATTRIBUTES,
}

const STARTF_USESTDHANDLES: u32 = 0x00000100;
const EXTENDED_STARTUPINFO_PRESENT: u32 = 0x00080000;
const CREATE_SUSPENDED: u32 = 0x00000004;
const CREATE_UNICODE_ENVIRONMENT: u32 = 0x00000400;
const HANDLE_FLAG_INHERIT: u32 = 0x00000001;
const PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES: usize = 0x00020009;
const PROC_THREAD_ATTRIBUTE_HANDLE_LIST: usize = 0x00020002;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x00002000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
const SDDL_REVISION_1: u32 = 1;

#[link(name = "kernel32")]
#[link(name = "advapi32")]
#[link(name = "userenv")]
unsafe extern "system" {
    fn CreateAppContainerProfile(
        pszAppContainerName: *const u16,
        pszDisplayName: *const u16,
        pszDescription: *const u16,
        pCapabilities: *const SID_AND_ATTRIBUTES,
        dwCapabilityCount: u32,
        ppSidAppContainerSid: *mut *mut c_void,
    ) -> i32;

    fn DeleteAppContainerProfile(pszAppContainerName: *const u16) -> i32;

    fn DeriveAppContainerSidFromAppContainerName(
        pszAppContainerName: *const u16,
        ppsidAppContainerSid: *mut *mut c_void,
    ) -> i32;

    fn FreeSid(pSid: *mut c_void) -> *mut c_void;

    fn ConvertSidToStringSidW(Sid: *mut c_void, StringSid: *mut *mut u16) -> i32;
    fn ConvertStringSidToSidW(StringSid: *const u16, Sid: *mut *mut c_void) -> i32;

    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
        StringSecurityDescriptor: *const u16,
        StringSDRevision: u32,
        SecurityDescriptor: *mut *mut c_void,
        SecurityDescriptorSize: *mut u32,
    ) -> i32;

    fn LocalFree(hMem: *mut c_void) -> *mut c_void;

    fn InitializeProcThreadAttributeList(
        lpAttributeList: *mut c_void,
        dwAttributeCount: u32,
        dwFlags: u32,
        lpSize: *mut usize,
    ) -> i32;

    fn UpdateProcThreadAttribute(
        lpAttributeList: *mut c_void,
        dwFlags: u32,
        Attribute: usize,
        lpValue: *mut c_void,
        cbSize: usize,
        lpPreviousValue: *mut c_void,
        lpReturnSize: *mut usize,
    ) -> i32;

    fn DeleteProcThreadAttributeList(lpAttributeList: *mut c_void);

    fn CreatePipe(
        hReadPipe: *mut *mut c_void,
        hWritePipe: *mut *mut c_void,
        lpPipeAttributes: *const SECURITY_ATTRIBUTES,
        nSize: u32,
    ) -> i32;

    fn SetHandleInformation(hObject: *mut c_void, dwMask: u32, dwFlags: u32) -> i32;
    fn CloseHandle(hObject: *mut c_void) -> i32;

    fn CreateJobObjectW(lpJobAttributes: *mut c_void, lpName: *const u16) -> *mut c_void;
    fn SetInformationJobObject(
        hJob: *mut c_void,
        JobObjectInfoClass: i32,
        lpJobObjectInfo: *const c_void,
        cbJobObjectInfoLength: u32,
    ) -> i32;
    fn AssignProcessToJobObject(hJob: *mut c_void, hProcess: *mut c_void) -> i32;

    fn CreateProcessW(
        lpApplicationName: *const u16,
        lpCommandLine: *mut u16,
        lpProcessAttributes: *mut c_void,
        lpThreadAttributes: *mut c_void,
        bInheritHandles: i32,
        dwCreationFlags: u32,
        lpEnvironment: *mut c_void,
        lpCurrentDirectory: *const u16,
        lpStartupInfo: *const STARTUPINFOEXW,
        lpProcessInformation: *mut PROCESS_INFORMATION,
    ) -> i32;

    fn OpenProcessToken(h: *mut c_void, desired: u32, tok: *mut *mut c_void) -> i32;
    fn GetCurrentProcess() -> *mut c_void;
    fn CreateRestrictedToken(
        ExistingTokenHandle: *mut c_void,
        Flags: u32,
        DisableSidCount: u32,
        SidsToDisable: *mut c_void,
        DeletePrivilegeCount: u32,
        PrivilegesToDelete: *mut c_void,
        RestrictedSidCount: u32,
        SidsToRestrict: *mut c_void,
        NewTokenHandle: *mut *mut c_void,
    ) -> i32;
    fn SetTokenInformation(
        TokenHandle: *mut c_void,
        TokenInformationClass: i32,
        TokenInformation: *const c_void,
        TokenInformationLength: u32,
    ) -> i32;
    fn CreateProcessAsUserW(
        hToken: *mut c_void,
        lpApplicationName: *const u16,
        lpCommandLine: *mut u16,
        lpProcessAttributes: *mut c_void,
        lpThreadAttributes: *mut c_void,
        bInheritHandles: i32,
        dwCreationFlags: u32,
        lpEnvironment: *mut c_void,
        lpCurrentDirectory: *const u16,
        lpStartupInfo: *const STARTUPINFOW,
        lpProcessInformation: *mut PROCESS_INFORMATION,
    ) -> i32;

    fn ResumeThread(hThread: *mut c_void) -> u32;
    fn WaitForSingleObject(hHandle: *mut c_void, dwMilliseconds: u32) -> u32;
    fn GetExitCodeProcess(hProcess: *mut c_void, lpExitCode: *mut u32) -> i32;
    fn ReadFile(
        hFile: *mut c_void,
        lpBuffer: *mut u8,
        nNumberOfBytesToRead: u32,
        lpNumberOfBytesRead: *mut u32,
        lpOverlapped: *mut c_void,
    ) -> i32;
    fn GetLastError() -> u32;
}


#[link(name = "advapi32")]
unsafe extern "system" {
    fn GetSecurityInfo(handle: *mut c_void, kind: u32, info: u32, owner: *mut *mut c_void, group: *mut *mut c_void, dacl: *mut *mut c_void, sacl: *mut *mut c_void, sd: *mut *mut c_void) -> u32;
    fn GetAce(acl: *mut c_void, index: u32, ace: *mut *mut c_void) -> i32;
    fn DeleteAce(acl: *mut c_void, index: u32) -> i32;
    fn EqualSid(left: *const c_void, right: *const c_void) -> i32;
    fn GetNamedSecurityInfoW(name: *const u16, kind: u32, info: u32, owner: *mut *mut c_void, group: *mut *mut c_void, dacl: *mut *mut c_void, sacl: *mut *mut c_void, sd: *mut *mut c_void) -> u32;
    fn SetSecurityInfo(handle: *mut c_void, kind: u32, info: u32, owner: *mut c_void, group: *mut c_void, dacl: *mut c_void, sacl: *mut c_void) -> u32;
    fn ConvertSecurityDescriptorToStringSecurityDescriptorW(sd: *mut c_void, revision: u32, info: u32, text: *mut *mut u16, length: *mut u32) -> i32;
    fn GetSecurityDescriptorSacl(sd: *mut c_void, present: *mut i32, sacl: *mut *mut c_void, defaulted: *mut i32) -> i32;
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetFileInformationByHandle(handle: *mut c_void, info: *mut BY_HANDLE_FILE_INFORMATION) -> i32;
    fn TerminateProcess(process: *mut c_void, code: u32) -> i32;
    fn WriteFile(handle: *mut c_void, buffer: *const u8, size: u32, written: *mut u32, overlapped: *mut c_void) -> i32;
}
fn wide(s: &str) -> Vec<u16> { std::ffi::OsStr::new(s).encode_wide().chain(Some(0)).collect() }
fn error(context: &str) -> String { format!("{context}: {}", std::io::Error::last_os_error()) }
fn check(ok: i32, context: &str) -> Result<(), String> { if ok == 0 { Err(error(context)) } else { Ok(()) } }
struct Handle(*mut c_void);
impl Drop for Handle { fn drop(&mut self) { if !self.0.is_null() { unsafe { CloseHandle(self.0); } } } }
struct Local(*mut c_void);
impl Drop for Local { fn drop(&mut self) { unsafe { LocalFree(self.0); } } }
unsafe fn text(ptr: *const u16) -> String {
    unsafe { let mut n=0; while *ptr.add(n)!=0 { n+=1; } String::from_utf16_lossy(std::slice::from_raw_parts(ptr,n)) }
}
fn sid(value: &str) -> Result<Local,String> {
    let mut p=std::ptr::null_mut(); unsafe { check(ConvertStringSidToSidW(wide(value).as_ptr(), &mut p), "parse SID")?; } Ok(Local(p))
}
fn label_get(path: &str) -> Result<String,String> {
    unsafe {
        let mut sd=std::ptr::null_mut(); let rc=GetNamedSecurityInfoW(wide(path).as_ptr(),1,0x10,std::ptr::null_mut(),std::ptr::null_mut(),std::ptr::null_mut(),std::ptr::null_mut(),&mut sd);
        if rc!=0 { return Err(format!("Read mandatory label: Win32 {rc}")); }
        let _sd=Local(sd); let mut s=std::ptr::null_mut();
        check(ConvertSecurityDescriptorToStringSecurityDescriptorW(sd,1,0x10,&mut s,std::ptr::null_mut()),"serialize label")?;
        let _s=Local(s as _); Ok(text(s))
    }
}
fn checked_file(path: &Path, access: u32) -> Result<std::fs::File,String> {
    // OPEN_REPARSE_POINT checks the object itself; BACKUP_SEMANTICS permits directories.
    let file=std::fs::OpenOptions::new().access_mode(access).custom_flags(0x00200000|0x02000000).open(path).map_err(|e|format!("Open label target {}: {e}",path.display()))?;
    let mut info:BY_HANDLE_FILE_INFORMATION=unsafe { std::mem::zeroed() };
    unsafe { check(GetFileInformationByHandle(file.as_raw_handle(),&mut info),"GetFileInformationByHandle")?; }
    if info.attributes & 0x400 != 0 { return Err(format!("Refusing reparse point: {}",path.display())); }
    if info.attributes & 0x10 == 0 && info.nNumberOfLinks > 1 { return Err(format!("Refusing hard link ({} links): {}",info.nNumberOfLinks,path.display())); }
    Ok(file)
}
fn label_set(path: &str, sddl: &str) -> Result<(),String> {
    // MAXIMUM_ALLOWED prevents SetSecurityInfo from propagating to unopened children.
    let file=checked_file(Path::new(path),0x02000000)?;
    unsafe {
        let mut sd=std::ptr::null_mut();
        check(ConvertStringSecurityDescriptorToSecurityDescriptorW(wide(sddl).as_ptr(),1,&mut sd,std::ptr::null_mut()),"parse label")?;
        let _sd=Local(sd); let mut acl=std::ptr::null_mut(); let mut present=0; let mut defaulted=0;
        check(GetSecurityDescriptorSacl(sd,&mut present,&mut acl,&mut defaulted),"get label SACL")?;
        let rc=SetSecurityInfo(file.as_raw_handle(),1,0x10,std::ptr::null_mut(),std::ptr::null_mut(),std::ptr::null_mut(),acl);
        if rc!=0 { return Err(format!("Set mandatory label: Win32 {rc}")); } Ok(())
    }
}
fn paths(root: &Path, result: &mut Vec<PathBuf>) -> Result<(),String> {
    let meta=std::fs::symlink_metadata(root).map_err(|e|e.to_string())?;
    use std::os::windows::fs::MetadataExt;
    if meta.file_attributes() & 0x400 != 0 { return Err("Refusing reparse point".into()); }
    checked_file(root,0)?;
    result.push(root.to_path_buf());
    if meta.is_dir() { for entry in std::fs::read_dir(root).map_err(|e|e.to_string())? { paths(&entry.map_err(|e|e.to_string())?.path(), result)?; } } Ok(())
}
fn remove_profile_aces(file: &std::fs::File, profile_sid: *const c_void) -> Result<(), String> {
    unsafe {
        let mut acl = std::ptr::null_mut();
        let mut sd = std::ptr::null_mut();
        let handle = file.as_raw_handle();
        let rc = GetSecurityInfo(handle, 1, 4, std::ptr::null_mut(), std::ptr::null_mut(), &mut acl, std::ptr::null_mut(), &mut sd);
        if rc != 0 { return Err(format!("Read profile DACL: Win32 {rc}")); }
        let _sd = Local(sd);
        if acl.is_null() { return Ok(()); }
        // ACL.AceCount is the u16 at offset 4. A basic allow ACE stores its SID
        // immediately after the 4-byte header and 4-byte access mask.
        let count = *acl.cast::<u16>().add(2) as u32;
        let mut changed = false;
        for index in (0..count).rev() {
            let mut ace = std::ptr::null_mut();
            check(GetAce(acl, index, &mut ace), "get ACE")?;
            if *ace.cast::<u8>() == 0 && EqualSid(ace.cast::<u8>().add(8).cast(), profile_sid) != 0 {
                check(DeleteAce(acl, index), "delete ACE")?;
                changed = true;
            }
        }
        if changed {
            let rc = SetSecurityInfo(handle, 1, 4, std::ptr::null_mut(), std::ptr::null_mut(), acl, std::ptr::null_mut());
            if rc != 0 { return Err(format!("Write profile DACL: Win32 {rc}")); }
        }
    }
    Ok(())
}
fn clean_profile_tree(root: &Path, profile_sid: *const c_void) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(root).map_err(|e| e.to_string())?;
    // Same refusal as labeling, with a handle opened MAXIMUM_ALLOWED so ACL
    // changes cannot propagate to unopened children (including junctions).
    let file = checked_file(root, 0x02000000)?;
    let mut complete = remove_profile_aces(&file, profile_sid).is_ok();
    if meta.is_dir() {
        for entry in std::fs::read_dir(root).map_err(|e| e.to_string())? {
            complete &= entry.is_ok_and(|entry| clean_profile_tree(&entry.path(), profile_sid).is_ok());
        }
    }
    if complete { Ok(()) } else { Err("Some profile ACEs could not be removed".into()) }
}
fn harden(path: &str, backup: &str) -> Result<(),String> {
    let mut entries=Vec::new(); paths(Path::new(path), &mut entries)?;
    let mut file=std::fs::OpenOptions::new().write(true).create_new(true).open(backup).map_err(|e|e.to_string())?;
    let mut saved=Vec::new();
    for entry in &entries { let p=entry.to_string_lossy().to_string(); saved.push((p.clone(),label_get(&p)?)); }
    for (p,s) in &saved { for v in [p,s] { file.write_all(&(v.len() as u32).to_le_bytes()).and_then(|_|file.write_all(v.as_bytes())).map_err(|e|e.to_string())?; } }
    file.sync_all().map_err(|e|e.to_string())?;
    for entry in entries { label_set(&entry.to_string_lossy(),"S:(ML;OICI;NWNR;;;ME)")?; } Ok(())
}
fn unharden(backup: &str) -> Result<(),String> {
    let bytes=std::fs::read(backup).map_err(|e|e.to_string())?; let mut pos=0; let mut saved=Vec::new();
    while pos<bytes.len() {
        let mut pair=Vec::new();
        for _ in 0..2 {
            if pos+4>bytes.len() { return Err("Invalid label backup".into()); }
            let n=u32::from_le_bytes(bytes[pos..pos+4].try_into().unwrap()) as usize; pos+=4;
            if pos+n>bytes.len() { return Err("Invalid label backup".into()); }
            pair.push(String::from_utf8(bytes[pos..pos+n].to_vec()).map_err(|e|e.to_string())?); pos+=n;
        } saved.push((pair.remove(0),pair.remove(0)));
    }
    for (p,s) in saved { label_set(&p,&s)?; } Ok(())
}
fn pipeline_profile(name: &str) -> bool {
    name.strip_prefix("scranton_").is_some_and(|id| id.len()==32 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}
fn derive_profile(name: &str) -> Result<String,String> {
    if !pipeline_profile(name) {return Err("Invalid Pipeline profile name".into());}
    unsafe {
        let mut p=std::ptr::null_mut();
        let hr=DeriveAppContainerSidFromAppContainerName(wide(name).as_ptr(),&mut p);
        if hr!=0 {return Err(format!("derive profile HRESULT {hr:#x}"));}
        let mut s=std::ptr::null_mut(); let ok=ConvertSidToStringSidW(p,&mut s); FreeSid(p);
        check(ok,"profile SID")?; let _s=Local(s as _); Ok(text(s))
    }
}
fn reap_profile(name: &str) -> Result<u32,String> {
    if !pipeline_profile(name) {return Err("Invalid Pipeline profile name".into());}
    let hr=unsafe {DeleteAppContainerProfile(wide(name).as_ptr())} as u32;
    match hr {0|0x80070002|0x80070003|0x80070490=>Ok(0), _=>Err(format!("DeleteAppContainerProfile HRESULT {hr:#x}"))}
}
fn profile(name: &str, create: bool) -> Result<String,String> {
    unsafe {
        if !create { let hr=DeleteAppContainerProfile(wide(name).as_ptr()); if hr!=0 { return Err(format!("DeleteAppContainerProfile HRESULT {hr:#x}")); } return Ok(String::new()); }
        let mut p=std::ptr::null_mut(); let n=wide(name);
        let hr=CreateAppContainerProfile(n.as_ptr(),n.as_ptr(),n.as_ptr(),std::ptr::null(),0,&mut p);
        if hr!=0 { return Err(format!("CreateAppContainerProfile HRESULT {hr:#x}")); }
        let mut s=std::ptr::null_mut(); let ok=ConvertSidToStringSidW(p,&mut s); FreeSid(p);
        check(ok,"profile SID")?; let _s=Local(s as _); Ok(text(s))
    }
}
struct Pipe { read: Handle, write: Handle }
fn pipe() -> Result<Pipe,String> {
    unsafe {
        let mut sd=std::ptr::null_mut();
        check(ConvertStringSecurityDescriptorToSecurityDescriptorW(wide("D:(A;;GA;;;OW)(A;;GA;;;AC)S:(ML;;NW;;;LW)").as_ptr(),1,&mut sd,std::ptr::null_mut()),"pipe security")?;
        let _sd=Local(sd); let sa=SECURITY_ATTRIBUTES { nLength:std::mem::size_of::<SECURITY_ATTRIBUTES>() as _,lpSecurityDescriptor:sd,bInheritHandle:1 };
        let mut r=std::ptr::null_mut(); let mut w=std::ptr::null_mut();
        check(CreatePipe(&mut r,&mut w,&sa,0),"CreatePipe")?; Ok(Pipe {read:Handle(r),write:Handle(w)})
    }
}
fn pump(handle: Handle, stderr: bool) -> std::thread::JoinHandle<()> {
    let raw=handle.0 as usize; std::mem::forget(handle);
    std::thread::spawn(move || { let h=Handle(raw as _); let mut buf=[0u8;8192]; loop { let mut n=0; if unsafe { ReadFile(h.0,buf.as_mut_ptr(),8192,&mut n,std::ptr::null_mut()) }==0 || n==0 { break; }
        let result=if stderr {std::io::stderr().write_all(&buf[..n as usize])} else {std::io::stdout().write_all(&buf[..n as usize])}; if result.is_err() {break;}
    } })
}
fn quote(arg: &str) -> String {
    let mut out=String::from("\""); let mut slashes=0;
    for c in arg.chars() { if c=='\\' {slashes+=1;} else { if c=='"' {out.push_str(&"\\".repeat(slashes*2+1));} else {out.push_str(&"\\".repeat(slashes));} slashes=0; out.push(c); } }
    out.push_str(&"\\".repeat(slashes*2)); out.push('"'); out
}
fn payload_environment(names: &str) -> Vec<u16> {
    // libuv inserts a few essential host variables even with explicit env.
    // Only keys supplied by Pipeline may cross into the payload token.
    let mut entries:Vec<_>=std::env::vars_os().filter(|(key,_)| names.split('\n').any(|name| name.eq_ignore_ascii_case(&key.to_string_lossy()))).collect();
    entries.sort_by_key(|(key,_)| key.to_string_lossy().to_uppercase());
    let mut block=Vec::new();
    for (key,value) in entries {block.extend(key.encode_wide()); block.push(b'=' as u16); block.extend(value.encode_wide()); block.push(0);}
    if block.is_empty() {block.push(0);}
    block.push(0);
    block
}
fn exec(opts: &std::collections::HashMap<String,String>, command: &[String]) -> Result<u32,String> {
    let cwd=opts.get("--cwd").ok_or("--cwd required")?;
    let mode=opts.get("--mode").map(String::as_str).unwrap_or("low");
    if !["low","strict"].contains(&mode) {return Err("mode must be low or strict".into());}
    let network=opts.get("--network").map(String::as_str).unwrap_or("allow");
    if !["allow","none"].contains(&network) { return Err("network must be allow or none".into()); }
    if mode=="low" && network=="none" {return Err("Low mode cannot block network; use strict mode or Docker".into());}
    if command.is_empty() {return Err("command required after --".into());}
    let number=|key: &str| -> Result<Option<u64>,String> { opts.get(key).map(|v|v.parse::<u64>().map_err(|_|format!("Invalid {key}"))).transpose() };
    let timeout=number("--timeout-ms")?; let memory=number("--memory-mb")?; let processes=number("--processes")?; let cpu=number("--cpu-ms")?;
    if [timeout,memory,processes,cpu].iter().flatten().any(|v|*v==0) {return Err("Limits must be positive".into());}
    unsafe {
        let job=Handle(CreateJobObjectW(std::ptr::null_mut(),std::ptr::null())); if job.0.is_null() {return Err(error("CreateJobObject"));}
        let mut limits:JOBOBJECT_EXTENDED_LIMIT_INFORMATION=std::mem::zeroed(); limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if let Some(m)=memory {limits.JobMemoryLimit=usize::try_from(m.checked_mul(1024*1024).ok_or("memory overflow")?).map_err(|_|"memory overflow")?; limits.BasicLimitInformation.LimitFlags|=0x200;}
        if let Some(n)=processes {limits.BasicLimitInformation.ActiveProcessLimit=u32::try_from(n).map_err(|_|"process limit overflow")?; limits.BasicLimitInformation.LimitFlags|=8;}
        if let Some(n)=cpu {limits.BasicLimitInformation.PerJobUserTimeLimit=i64::try_from(n.checked_mul(10000).ok_or("cpu limit overflow")?).map_err(|_|"cpu limit overflow")?; limits.BasicLimitInformation.LimitFlags|=4;}
        check(SetInformationJobObject(job.0,9,&limits as *const _ as _,std::mem::size_of_val(&limits) as _),"job limits")?;
        let input=pipe()?; let output=pipe()?; let errors=pipe()?;
        for h in [input.write.0,output.read.0,errors.read.0] {check(SetHandleInformation(h,HANDLE_FLAG_INHERIT,0),"pipe inheritance")?;}
        let mut size=0; InitializeProcThreadAttributeList(std::ptr::null_mut(),2,0,&mut size);
        let mut storage=vec![0usize;size.div_ceil(std::mem::size_of::<usize>())]; let attrs=storage.as_mut_ptr() as *mut c_void;
        check(InitializeProcThreadAttributeList(attrs,2,0,&mut size),"initialize attributes")?;
        struct Attributes(*mut c_void); impl Drop for Attributes {fn drop(&mut self){unsafe {DeleteProcThreadAttributeList(self.0);}}} let _attrs=Attributes(attrs);
        let mut handles=[input.read.0,output.write.0,errors.write.0];
        check(UpdateProcThreadAttribute(attrs,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,handles.as_mut_ptr() as _,std::mem::size_of_val(&handles),std::ptr::null_mut(),std::ptr::null_mut()),"inherit handle whitelist")?;
        let mut token=std::ptr::null_mut(); check(OpenProcessToken(GetCurrentProcess(),0x02000000,&mut token),"open token")?; let _token=Handle(token);
        let admin=sid("S-1-5-32-544")?; let mut deny=SID_AND_ATTRIBUTES {Sid:admin.0,Attributes:0}; let mut restricted=std::ptr::null_mut();
        check(CreateRestrictedToken(token,5,1,&mut deny as *mut _ as _,0,std::ptr::null_mut(),0,std::ptr::null_mut(),&mut restricted),"restricted token")?; let _restricted=Handle(restricted);
        let low=sid("S-1-16-4096")?; let label=TOKEN_MANDATORY_LABEL {Label:SID_AND_ATTRIBUTES{Sid:low.0,Attributes:0x20}};
        check(SetTokenInformation(restricted,25,&label as *const _ as _,std::mem::size_of_val(&label) as _),"Low integrity")?;
        let mut container_sid=std::ptr::null_mut();
        if mode=="strict" {
            let name=opts.get("--profile").ok_or("strict requires --profile")?;
            let hr=DeriveAppContainerSidFromAppContainerName(wide(name).as_ptr(),&mut container_sid); if hr!=0 {return Err(format!("derive profile HRESULT {hr:#x}"));}
        }
        struct Sid(*mut c_void); impl Drop for Sid {fn drop(&mut self){if !self.0.is_null(){unsafe {FreeSid(self.0);}}}} let _sid=Sid(container_sid);
        let mut caps=SECURITY_CAPABILITIES {AppContainerSid:container_sid,Capabilities:std::ptr::null_mut(),CapabilityCount:0,Reserved:0};
        if mode=="strict" {check(UpdateProcThreadAttribute(attrs,0,PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,&mut caps as *mut _ as _,std::mem::size_of_val(&caps),std::ptr::null_mut(),std::ptr::null_mut()),"AppContainer capabilities")?;}
        let mut si:STARTUPINFOEXW=std::mem::zeroed(); si.StartupInfo.cb=std::mem::size_of_val(&si) as _; si.StartupInfo.dwFlags=STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput=input.read.0; si.StartupInfo.hStdOutput=output.write.0; si.StartupInfo.hStdError=errors.write.0; si.lpAttributeList=attrs;
        // cmd.exe parses a raw tail, unlike CommandLineToArgvW consumers.
        let is_cmd=Path::new(&command[0]).file_name().unwrap_or_default().to_string_lossy().eq_ignore_ascii_case("cmd.exe");
        let line=if is_cmd {{ let split=command.iter().position(|v|v.eq_ignore_ascii_case("/c") || v.eq_ignore_ascii_case("/k")).ok_or("cmd requires /c or /k")?; format!("{} {} \"{}\"",quote(&command[0]),command[1..=split].join(" "),command[split+1..].join(" ")) }} else {command.iter().map(|a|quote(a)).collect::<Vec<_>>().join(" ")};
        let mut line=wide(&line); let mut pi:PROCESS_INFORMATION=std::mem::zeroed();
        let env=opts.get("--pipeline-env").map(|names| payload_environment(names));
        let env_ptr=env.as_ref().map_or(std::ptr::null_mut(),|block|block.as_ptr().cast_mut().cast());
        check(CreateProcessAsUserW(restricted,wide(&command[0]).as_ptr(),line.as_mut_ptr(),std::ptr::null_mut(),std::ptr::null_mut(),1,CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT|EXTENDED_STARTUPINFO_PRESENT,env_ptr,wide(cwd).as_ptr(),&si.StartupInfo,&mut pi),"create sandbox process")?;
        let process=Handle(pi.hProcess); let thread=Handle(pi.hThread);
        if AssignProcessToJobObject(job.0,process.0)==0 {TerminateProcess(process.0,125); return Err(error("assign job"));}
        if ResumeThread(thread.0)==u32::MAX {TerminateProcess(process.0,125); return Err(error("resume process"));}
        drop(input.read); drop(output.write); drop(errors.write);
        let out=pump(output.read,false); let err=pump(errors.read,true);
        let raw=input.write.0 as usize; std::mem::forget(input.write);
        std::thread::spawn(move || {let h=Handle(raw as _); let mut buf=[0u8;8192]; while let Ok(n)=std::io::stdin().read(&mut buf) {if n==0 {break;} let mut offset=0; while offset<n {let mut written=0; if WriteFile(h.0,buf[offset..n].as_ptr(),(n-offset) as _,&mut written,std::ptr::null_mut())==0 || written==0 {return;} offset+=written as usize;} } });
        let wait=WaitForSingleObject(process.0,timeout.map(|v|v.min(u32::MAX as u64-1) as u32).unwrap_or(u32::MAX));
        let mut code=0;
        if wait==258 {code=124;} else if wait!=0 {return Err(error("wait process"));} else {check(GetExitCodeProcess(process.0,&mut code),"exit code")?;}
        drop(job); let _=out.join(); let _=err.join(); Ok(code)
    }
}
fn pipeline_exec(opts: &std::collections::HashMap<String,String>, command: &[String], status: &str) -> Result<u32,String> {
    use std::io::Write;
    // The status path is host-only; its handle is not on the payload inheritance list.
    let Ok(mut file)=std::fs::OpenOptions::new().write(true).create_new(true).open(status) else {return Ok(125);};
    let (tag, code)=pipeline_result(exec(opts,command));
    if file.write_all(tag).and_then(|_|file.sync_all()).is_err() {return Ok(125);}
    Ok(code)
}
fn pipeline_result(result: Result<u32,String>) -> (&'static [u8], u32) {
    match result {Ok(code)=>(b"exited\n",code), Err(_)=>(b"launch\n",125)}
}
pub fn main_result() -> Result<u32,String> {
    let args:Vec<String>=std::env::args().skip(1).collect(); let action=args.first().ok_or("command required")?;
    let mut opts=std::collections::HashMap::new(); let mut i=1;
    while i<args.len() && args[i]!="--" {if !args[i].starts_with("--") || i+1>=args.len() {return Err("Expected --option value".into());} if opts.insert(args[i].clone(),args[i+1].clone()).is_some() {return Err("Duplicate option".into());} i+=2;}
    let get=|key:&str|opts.get(key).map(String::as_str).ok_or_else(||format!("{key} required"));
    let allowed:&[&str]=match action.as_str() {"exec"=>&["--cwd","--mode","--network","--profile","--timeout-ms","--memory-mb","--processes","--cpu-ms","--pipeline-status","--pipeline-env"],"label-low"|"pipeline-check-tree"=>&["--path"],"harden"=>&["--path","--backup"],"pipeline-profile-clean-tree"=>&["--name","--path"],"unharden"=>&["--backup"],"profile-create"|"profile-delete"|"pipeline-profile-derive"|"pipeline-profile-reap"=>&["--name"],_=>return Err("Unknown command".into())};
    if opts.keys().any(|k|!allowed.contains(&k.as_str())) {return Err("Unknown option".into());}
    match action.as_str() {
        "exec"=>{
            let command=if i<args.len(){&args[i+1..]}else{&[]};
            if let Some(status)=opts.get("--pipeline-status") {pipeline_exec(&opts,command,status)} else if opts.contains_key("--pipeline-env") {Err("--pipeline-env requires --pipeline-status".into())} else {exec(&opts,command)}
        },
        "pipeline-check-tree"=>{paths(Path::new(get("--path")?),&mut Vec::new())?;Ok(0)},
        "pipeline-profile-derive"=>{println!("{}",derive_profile(get("--name")?)?);Ok(0)},
        "pipeline-profile-reap"=>reap_profile(get("--name")?),
        "pipeline-profile-clean-tree"=>{
            let profile_sid = sid(&derive_profile(get("--name")?)?)?;
            clean_profile_tree(Path::new(get("--path")?), profile_sid.0)?;
            Ok(0)
        },
        "label-low"=>{let mut entries=Vec::new(); paths(Path::new(get("--path")?),&mut entries)?; for entry in entries {label_set(&entry.to_string_lossy(),"S:(ML;OICI;NW;;;LW)")?;} Ok(0)},
        "harden"=>{harden(get("--path")?,get("--backup")?)?;Ok(0)},
        "unharden"=>{unharden(get("--backup")?)?;Ok(0)},
        "profile-create"=>{println!("{}",profile(get("--name")?,true)?);Ok(0)},
        "profile-delete"=>{profile(get("--name")?,false)?;Ok(0)},
        _=>unreachable!()
    }
}

#[cfg(test)]
mod pipeline_tests {
    use super::*;

    #[test]
    fn pipeline_status_preserves_reserved_tool_exits() {
        assert_eq!(pipeline_result(Ok(124)), (&b"exited\n"[..], 124));
        assert_eq!(pipeline_result(Ok(125)), (&b"exited\n"[..], 125));
        assert_eq!(pipeline_result(Err("launch failed".into())), (&b"launch\n"[..], 125));
    }

    #[test]
    fn pipeline_recovery_only_accepts_generated_profile_names() {
        assert!(pipeline_profile("scranton_0123456789abcdef0123456789abcdef"));
        assert!(!pipeline_profile("scranton_0123456789abcdef0123456789abcdeF"));
        assert!(!pipeline_profile("scranton_0123456789abcdef0123456789abcde"));
        assert!(!pipeline_profile("unrelated"));
    }
}
