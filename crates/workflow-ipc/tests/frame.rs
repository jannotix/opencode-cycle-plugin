use workflow_core::{ProtocolEnvelope, ProtocolPayload, RequestRecord, UserRoutingPreference};
use workflow_ipc::{FrameDecoder, FrameError, IpcRequest, MAX_FRAME_BYTES, encode_frame};

fn request(id: u64) -> IpcRequest {
    IpcRequest {
        affected_paths: Vec::new(),
        critical_downgrade_approval: None,
        project_key: "project".to_owned(),
        request_id: id,
        routing_preference: UserRoutingPreference::Auto,
        workflow_id: None,
        envelope: ProtocolEnvelope::new(ProtocolPayload::Request(RequestRecord::new(
            format!("request {id}"),
            Vec::new(),
        ))),
    }
}

#[test]
fn parses_fragmented_frames() {
    let expected = request(7);
    let frame = encode_frame(&expected).unwrap();
    let mut decoder = FrameDecoder::new();
    let mut decoded = Vec::new();
    for byte in frame {
        decoded.extend(decoder.feed_json::<IpcRequest>(&[byte]).unwrap());
    }
    assert_eq!(decoded, [expected]);
}

#[test]
fn parses_concatenated_frames_without_cross_delivery() {
    let first = request(1);
    let second = request(2);
    let bytes = [
        encode_frame(&first).unwrap(),
        encode_frame(&second).unwrap(),
    ]
    .concat();
    let decoded = FrameDecoder::new().feed_json::<IpcRequest>(&bytes).unwrap();
    assert_eq!(decoded, [first, second]);
}

#[test]
fn oversized_header_fails_before_payload_allocation_and_poisoned_decoder_stays_closed() {
    let announced = u32::try_from(MAX_FRAME_BYTES + 1).unwrap();
    let mut decoder = FrameDecoder::new();
    assert!(matches!(
        decoder.feed(&announced.to_be_bytes()),
        Err(FrameError::Oversized { .. })
    ));
    assert_eq!(decoder.buffered_bytes(), 0);
    assert!(matches!(
        decoder.feed(b"ignored"),
        Err(FrameError::Poisoned)
    ));
}

#[test]
fn malformed_json_and_unknown_protocol_versions_fail_closed() {
    let malformed = [3_u32.to_be_bytes().as_slice(), b"bad"].concat();
    let mut decoder = FrameDecoder::new();
    assert!(matches!(
        decoder.feed_json::<IpcRequest>(&malformed),
        Err(FrameError::Json(_))
    ));
    assert!(matches!(
        decoder.feed(b"ignored"),
        Err(FrameError::Poisoned)
    ));

    let mut value = serde_json::to_value(request(1)).unwrap();
    value["envelope"]["version"] = serde_json::json!(2);
    let frame = encode_frame(&value).unwrap();
    assert!(matches!(
        FrameDecoder::new().feed_json::<IpcRequest>(&frame),
        Err(FrameError::Json(_))
    ));
}

#[test]
fn arbitrary_input_never_buffers_more_than_the_declared_limit() {
    let mut seed = 0x9e37_79b9_u32;
    for _ in 0..10_000 {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        let bytes = seed.to_be_bytes();
        let mut decoder = FrameDecoder::new();
        let _ = decoder.feed(&bytes);
        assert!(decoder.buffered_bytes() <= MAX_FRAME_BYTES);
    }
}
