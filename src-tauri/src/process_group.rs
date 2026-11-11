use std::process::{Child, Command};

pub fn isolate(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(not(unix))]
    let _ = command;
}

pub fn kill_owned_group(child: &mut Child) {
    #[cfg(unix)]
    {
        unsafe extern "C" {
            fn getpgid(pid: i32) -> i32;
            fn kill(pid: i32, signal: i32) -> i32;
        }
        // Never signal a reaped PID/group: an unreaped direct child pins its PID against reuse.
        if matches!(child.try_wait(), Ok(None)) {
            if let Ok(pid) = i32::try_from(child.id()) {
                if pid > 1 && unsafe { getpgid(pid) } == pid {
                    unsafe { kill(-pid, 9); } // SIGKILL after the graceful quit deadline.
                }
            }
        }
    }
    #[cfg(not(unix))]
    let _ = child;
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{io::{BufRead, BufReader}, process::Stdio};

    #[test]
    fn kills_inherited_group_without_touching_sibling() {
        let mut sibling = Command::new("sleep").arg("30").spawn().unwrap();
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 30 & echo ready; wait"]).stdout(Stdio::piped());
        isolate(&mut command);
        let mut child = command.spawn().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        assert_eq!(line.trim(), "ready");
        kill_owned_group(&mut child);
        assert!(!child.wait().unwrap().success());
        // The grandchild inherited stdout: EOF proves it no longer holds the pipe open.
        line.clear();
        assert_eq!(output.read_line(&mut line).unwrap(), 0);
        assert!(sibling.try_wait().unwrap().is_none());
        sibling.kill().unwrap();
        sibling.wait().unwrap();
        kill_owned_group(&mut child); // A reaped child must be a no-op.
    }

    #[test]
    fn refuses_shared_process_group() {
        let mut child = Command::new("sleep").arg("30").spawn().unwrap();
        kill_owned_group(&mut child);
        assert!(child.try_wait().unwrap().is_none());
        child.kill().unwrap();
        child.wait().unwrap();
    }
}
