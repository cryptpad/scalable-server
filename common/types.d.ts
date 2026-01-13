// Message sent to start a server
declare interface Message {
    name: string,
    index: number,
    config: {
        myId: string,
        index: number
        config: object,
        infra: object,
    }
}

