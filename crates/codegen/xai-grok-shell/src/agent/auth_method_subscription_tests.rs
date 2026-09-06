use super::*;

#[test]
fn subscription_auth_is_session_local_and_native_login_remains_live() {
    let global = new_shared_auth_method_id(None);
    let subscription = subscription_session_auth(&global);
    assert!(global.load().is_none());
    assert_eq!(
        subscription.load().unwrap().0.as_ref(),
        XAI_API_KEY_METHOD_ID
    );
    assert!(!is_session_based_method(
        subscription.load().as_deref().unwrap()
    ));

    // Explicit native login propagates to the same already-running session.
    global.store(Some(std::sync::Arc::new(acp::AuthMethodId::new(
        GROK_COM_METHOD_ID,
    ))));
    assert_eq!(subscription.load().unwrap().0.as_ref(), GROK_COM_METHOD_ID);
    assert!(is_session_based_method(
        subscription.load().as_deref().unwrap()
    ));
    global.store(None);
    assert!(global.load().is_none());
    assert_eq!(
        subscription.load().unwrap().0.as_ref(),
        XAI_API_KEY_METHOD_ID
    );
}
