use tokio::io::{AsyncReadExt, AsyncWriteExt};
use workflow_ipc::transport::{LocalListener, connect};

#[cfg(unix)]
use workflow_ipc::transport::{MAX_UNIX_SOCKET_PATH_BYTES, validate_socket_path};

#[cfg(windows)]
fn endpoint() -> String {
    workflow_core::ContentDigest::of(uuid_seed().as_bytes()).to_string()[..32].to_owned()
}

#[cfg(unix)]
fn endpoint() -> tempfile::TempDir {
    tempfile::TempDir::new().unwrap()
}

#[cfg(windows)]
fn uuid_seed() -> String {
    workflow_core::WorkflowId::new().to_string()
}

#[cfg(windows)]
#[tokio::test]
async fn current_user_client_connects_and_exchanges_isolated_bytes() {
    let endpoint = endpoint();
    let mut listener = LocalListener::bind(&endpoint).unwrap();
    let client = connect(&endpoint);
    let server = listener.accept();
    let (mut client, mut server) = tokio::try_join!(client, server).unwrap();
    client.write_all(b"client-one").await.unwrap();
    let mut received = [0_u8; 10];
    server.read_exact(&mut received).await.unwrap();
    assert_eq!(&received, b"client-one");
}

#[cfg(windows)]
#[tokio::test]
async fn concurrent_named_pipe_clients_do_not_cross_deliver() {
    let endpoint = endpoint();
    let mut listener = LocalListener::bind(&endpoint).unwrap();
    let server = async {
        let first = listener.accept().await.unwrap();
        let second = listener.accept().await.unwrap();
        tokio::try_join!(echo(first), echo(second)).unwrap();
    };
    let first = exchange(&endpoint, b"first");
    let second = exchange(&endpoint, b"second");
    let (_, first_reply, second_reply) = tokio::join!(server, first, second);
    assert_eq!(first_reply, b"first");
    assert_eq!(second_reply, b"second");
}

#[cfg(windows)]
#[tokio::test]
async fn rapid_named_pipe_clients_all_reach_an_accepted_instance() {
    const CLIENTS: usize = 64;
    let endpoint = endpoint();
    let mut listener = LocalListener::bind(&endpoint).unwrap();
    let server = async {
        for _ in 0..CLIENTS {
            let mut stream = listener.accept().await.unwrap();
            stream.write_all(&[0x5a]).await.unwrap();
        }
    };
    let clients = async {
        let mut tasks = tokio::task::JoinSet::new();
        for _ in 0..CLIENTS {
            let endpoint = endpoint.clone();
            tasks.spawn(async move {
                let mut stream = connect(&endpoint).await.unwrap();
                let mut challenge = [0_u8; 1];
                stream.read_exact(&mut challenge).await.unwrap();
                assert_eq!(challenge, [0x5a]);
            });
        }
        while let Some(result) = tasks.join_next().await {
            result.unwrap();
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        tokio::join!(server, clients);
    })
    .await
    .expect("rapid clients must not starve behind an unaccepted pipe instance");
}

#[cfg(windows)]
async fn echo(mut stream: tokio::net::windows::named_pipe::NamedPipeServer) -> std::io::Result<()> {
    let mut length = [0_u8; 1];
    stream.read_exact(&mut length).await?;
    let mut message = vec![0_u8; usize::from(length[0])];
    stream.read_exact(&mut message).await?;
    stream.write_all(&length).await?;
    stream.write_all(&message).await
}

#[cfg(windows)]
async fn exchange(endpoint: &str, message: &[u8]) -> Vec<u8> {
    let mut stream = connect(endpoint).await.unwrap();
    let length = u8::try_from(message.len()).unwrap();
    stream.write_all(&[length]).await.unwrap();
    stream.write_all(message).await.unwrap();
    let mut reply_length = [0_u8; 1];
    stream.read_exact(&mut reply_length).await.unwrap();
    let mut reply = vec![0_u8; usize::from(reply_length[0])];
    stream.read_exact(&mut reply).await.unwrap();
    reply
}

#[cfg(unix)]
#[tokio::test]
async fn current_user_client_connects_and_stale_endpoint_recovers() {
    let temporary = endpoint();
    let path = temporary.path().join("workflow.sock");
    std::fs::write(&path, b"not a socket").unwrap();
    assert!(LocalListener::bind(&path).is_err());
    std::fs::remove_file(&path).unwrap();
    drop(std::os::unix::net::UnixListener::bind(&path).unwrap());

    let listener = LocalListener::bind(&path).unwrap();
    let client = connect(&path);
    let server = listener.accept();
    let (mut client, mut server) = tokio::try_join!(client, server).unwrap();
    client.write_all(b"local").await.unwrap();
    let mut received = [0_u8; 5];
    server.read_exact(&mut received).await.unwrap();
    assert_eq!(&received, b"local");
}

#[cfg(unix)]
#[test]
fn unix_socket_path_bound_counts_encoded_bytes_exactly() {
    let exact = std::path::PathBuf::from("a".repeat(MAX_UNIX_SOCKET_PATH_BYTES));
    assert_eq!(
        validate_socket_path(&exact).unwrap(),
        MAX_UNIX_SOCKET_PATH_BYTES
    );
    let over = std::path::PathBuf::from("a".repeat(MAX_UNIX_SOCKET_PATH_BYTES + 1));
    assert_eq!(
        validate_socket_path(&over).unwrap_err().kind(),
        std::io::ErrorKind::InvalidInput
    );

    let utf8_within = std::path::PathBuf::from("é".repeat(MAX_UNIX_SOCKET_PATH_BYTES / 2));
    assert_eq!(validate_socket_path(&utf8_within).unwrap(), 106);
    let utf8_over = std::path::PathBuf::from("é".repeat(MAX_UNIX_SOCKET_PATH_BYTES / 2 + 1));
    assert_eq!(
        validate_socket_path(&utf8_over).unwrap_err().kind(),
        std::io::ErrorKind::InvalidInput
    );
}
